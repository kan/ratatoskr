import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { BootstrapResponse, Feed } from '../../shared/types';
import { apiGet, apiJson } from '../test/request';
import { seedEntry, seedFeed, seedPin, setReadSeq } from '../test/seed';

/** 自分が投入したフィードだけを取り出す */
function only(body: BootstrapResponse, ids: number[]): Feed[] {
  return body.feeds.filter((feed) => ids.includes(feed.id));
}

describe('GET /api/bootstrap', () => {
  it('フィードをレート降順・未読数降順で返し、未読数を数える', async () => {
    const low = await seedFeed(env.DB, 'https://bs-low.example.com/feed', { rate: 1, title: '低' });
    const highFew = await seedFeed(env.DB, 'https://bs-high-few.example.com/feed', {
      rate: 5,
      title: '高・少',
    });
    const highMany = await seedFeed(env.DB, 'https://bs-high-many.example.com/feed', {
      rate: 5,
      title: '高・多',
    });

    await seedEntry(env.DB, low);
    await seedEntry(env.DB, highFew);
    for (let i = 0; i < 3; i += 1) await seedEntry(env.DB, highMany);

    const body = await apiJson<BootstrapResponse>('/api/bootstrap');
    const mine = only(body, [low, highFew, highMany]);

    expect(mine.map((feed) => feed.title)).toEqual(['高・多', '高・少', '低']);
    expect(mine.map((feed) => feed.unreadCount)).toEqual([3, 1, 1]);
    expect(body.schemaVersion).toBe(1);
    expect(body.serverTime).toBeLessThan(1e11);
  });

  it('read_seq 以下の記事は未読数に数えない', async () => {
    const id = await seedFeed(env.DB, 'https://bs-read.example.com/feed');
    const first = await seedEntry(env.DB, id);
    await seedEntry(env.DB, id);
    await setReadSeq(env.DB, id, first);

    const body = await apiJson<BootstrapResponse>('/api/bootstrap');
    expect(only(body, [id])[0].unreadCount).toBe(1);
  });

  it('上位フィードの未読記事だけを同梱する', async () => {
    const top = await seedFeed(env.DB, 'https://bs-top.example.com/feed', { rate: 5 });
    const bottom = await seedFeed(env.DB, 'https://bs-bottom.example.com/feed', { rate: 1 });
    const topEntry = await seedEntry(env.DB, top);
    const bottomEntry = await seedEntry(env.DB, bottom);

    // feeds=1 なら最上位の 1 本ぶんだけが本文付きで返る
    const body = await apiJson<BootstrapResponse>('/api/bootstrap?feeds=1');
    const ids = body.entries.map((entry) => entry.id);
    expect(ids).toContain(topEntry);
    expect(ids).not.toContain(bottomEntry);
  });

  it('entriesPerFeed でフィードごとの件数を絞る', async () => {
    const id = await seedFeed(env.DB, 'https://bs-limit.example.com/feed', { rate: 5 });
    for (let i = 0; i < 5; i += 1) await seedEntry(env.DB, id);

    const body = await apiJson<BootstrapResponse>('/api/bootstrap?entriesPerFeed=2');
    expect(body.entries.filter((entry) => entry.feedId === id)).toHaveLength(2);
  });

  it('maxEntryId は同梱した記事の範囲に依らずサーバの最大 id を返す', async () => {
    const id = await seedFeed(env.DB, 'https://bs-max.example.com/feed', { rate: 1 });
    const latest = await seedEntry(env.DB, id);

    const body = await apiJson<BootstrapResponse>('/api/bootstrap?feeds=0');
    expect(body.entries).toHaveLength(0);
    expect(body.maxEntryId).toBeGreaterThanOrEqual(latest);
  });

  it('ピンを返す', async () => {
    const pinId = await seedPin(env.DB, 'https://bs-pin.example.com/article');
    const body = await apiJson<BootstrapResponse>('/api/bootstrap');
    expect(body.pins.map((pin) => pin.id)).toContain(pinId);
  });

  it('不正なパラメータは 400', async () => {
    const response = await apiGet('/api/bootstrap?feeds=abc');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('本番のホスト名では Access の JWT が無いと 401', async () => {
    const response = await apiGet('/api/bootstrap', 'https://ratatoskr.example.com');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });
});
