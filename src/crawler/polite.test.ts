import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { selectRobots, upsertRobots } from '../db/robots';
import { resetDb } from '../test/seed';
import { createPoliteFetch } from './polite';
import { RobotsDisallowedError } from './robots';

/**
 * クロール中の行儀（issue #39）。見るのは「同じホストへ同時に 2 本出さない」
 * 「流量の制限を受けたら、その回はもう出さない」「記事ページは robots.txt に従う」。
 */

const NOW = 1_780_000_000;

interface Call {
  url: string;
}

/** 応答を手で返せる fetch。呼ばれた順と、同時に何本出ていたかを記録する */
function controlledFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let inFlight = 0;
  const peak = new Map<string, number>();
  const live = new Map<string, number>();
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    calls.push({ url });
    inFlight += 1;
    live.set(host, (live.get(host) ?? 0) + 1);
    peak.set(host, Math.max(peak.get(host) ?? 0, live.get(host) ?? 0));
    try {
      // 1 tick 置いて、並べて出された要求が重なる機会を作る
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await respond(url);
    } finally {
      inFlight -= 1;
      live.set(host, (live.get(host) ?? 1) - 1);
    }
  };
  return { impl: impl as unknown as typeof fetch, calls, peak, inFlight: () => inFlight };
}

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('createPoliteFetch', () => {
  it('同じホストへは 1 本ずつ、別のホストへは並べて出す', async () => {
    const stub = controlledFetch(() => new Response('ok'));
    const polite = createPoliteFetch(stub.impl, { now: NOW });

    await Promise.all([
      polite.fetch('https://a.example.com/1'),
      polite.fetch('https://a.example.com/2'),
      polite.fetch('https://a.example.com/3'),
      polite.fetch('https://b.example.com/1'),
    ]);

    expect(stub.peak.get('a.example.com')).toBe(1);
    expect(stub.calls).toHaveLength(4);
  });

  it('前の要求が失敗しても後続は詰まらない', async () => {
    let first = true;
    const stub = controlledFetch(() => {
      if (first) {
        first = false;
        throw new Error('network');
      }
      return new Response('ok');
    });
    const polite = createPoliteFetch(stub.impl, { now: NOW });

    const results = await Promise.allSettled([
      polite.fetch('https://a.example.com/1'),
      polite.fetch('https://a.example.com/2'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('429 を受けたホストには、その回もう出さずに同じ応答を返す', async () => {
    const stub = controlledFetch(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } }),
    );
    const polite = createPoliteFetch(stub.impl, { now: NOW });

    await polite.fetch('https://a.example.com/1');
    const second = await polite.fetch('https://a.example.com/2');

    expect(stub.calls.map((c) => c.url)).toEqual(['https://a.example.com/1']);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('7200');
  });

  describe('page（robots.txt）', () => {
    it('禁じられたページは取りに行かずに RobotsDisallowedError を投げる', async () => {
      const stub = controlledFetch((url) =>
        url.endsWith('/robots.txt')
          ? new Response('User-agent: *\nDisallow: /private/')
          : new Response('<p>本文</p>'),
      );
      const polite = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });

      await expect(polite.page('https://a.example.com/private/1')).rejects.toBeInstanceOf(
        RobotsDisallowedError,
      );
      const ok = await polite.page('https://a.example.com/public/1');

      expect(ok.status).toBe(200);
      // robots.txt は同じ回に 1 度しか取りに行かない
      expect(stub.calls.map((c) => c.url)).toEqual([
        'https://a.example.com/robots.txt',
        'https://a.example.com/public/1',
      ]);
    });

    it('控えが新しければ取りに行かない。期限が切れていれば取り直して控え直す', async () => {
      await upsertRobots(
        env.DB,
        'https://a.example.com',
        { state: 'ok', body: 'User-agent: *\nDisallow: /', expiresAt: NOW + 10 },
        NOW,
      );
      const stub = controlledFetch((url) =>
        url.endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow:') : new Response('x'),
      );

      const fresh = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });
      await expect(fresh.page('https://a.example.com/a')).rejects.toBeInstanceOf(
        RobotsDisallowedError,
      );
      expect(stub.calls).toHaveLength(0);

      const later = createPoliteFetch(stub.impl, { db: env.DB, now: NOW + 100 });
      const response = await later.page('https://a.example.com/a');
      expect(response.status).toBe(200);
      const stored = await selectRobots(env.DB, 'https://a.example.com');
      expect(stored?.body).toBe('User-agent: *\nDisallow:');
      expect(stored?.expiresAt).toBe(NOW + 100 + 86_400);
    });

    it('robots.txt が 404 なら全て許す', async () => {
      const stub = controlledFetch((url) =>
        url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response('x'),
      );
      const polite = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });
      expect((await polite.page('https://a.example.com/a')).status).toBe(200);
    });

    it('robots.txt が 5xx なら全て禁じる。前の控えがあればそれに従う', async () => {
      const stub = controlledFetch((url) =>
        url.endsWith('/robots.txt') ? new Response('', { status: 500 }) : new Response('x'),
      );

      const none = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });
      await expect(none.page('https://a.example.com/a')).rejects.toBeInstanceOf(
        RobotsDisallowedError,
      );

      await upsertRobots(
        env.DB,
        'https://b.example.com',
        { state: 'ok', body: 'User-agent: *\nDisallow: /secret', expiresAt: NOW - 1 },
        NOW - 86_400,
      );
      const stale = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });
      expect((await stale.page('https://b.example.com/a')).status).toBe(200);
    });

    it('robots.txt も取得の枠から引き、尽きていたら取りに行かずに禁じる扱いにする', async () => {
      const stub = controlledFetch(() => new Response('User-agent: *\nDisallow:'));
      const budget = { remaining: 1 };
      const polite = createPoliteFetch(stub.impl, { db: env.DB, now: NOW, budget });

      expect((await polite.page('https://a.example.com/x')).status).toBe(200);
      expect(budget.remaining).toBe(0);
      await expect(polite.page('https://b.example.com/x')).rejects.toBeInstanceOf(
        RobotsDisallowedError,
      );
      expect(stub.calls.map((c) => c.url)).toEqual([
        'https://a.example.com/robots.txt',
        'https://a.example.com/x',
      ]);
      // 枠切れで決めた扱いは控えに残さない（次の回に取りに行く）
      expect(await selectRobots(env.DB, 'https://b.example.com')).toBeNull();
    });

    it('フィード用の fetch は robots.txt を見ない', async () => {
      const stub = controlledFetch(() => new Response('x'));
      const polite = createPoliteFetch(stub.impl, { db: env.DB, now: NOW });
      await polite.fetch('https://a.example.com/feed.xml');
      expect(stub.calls.map((c) => c.url)).toEqual(['https://a.example.com/feed.xml']);
    });
  });
});
