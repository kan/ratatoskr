import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSkimmedFeeds, SKIM_MIN_VIEWS } from '../db/events';
import { apiSend } from '../test/request';
import { getFeedRow, resetDb, seedEntry, seedFeed, seedPin } from '../test/seed';

/**
 * 読み方のデータ（issue #43）。見るのは「重複して届いても 1 件」「記事が消えても
 * 何の記事だったか分かる」「ほとんど読まずに送っているフィードに印が付く」。
 */

const NOW = 1_790_000_000;

interface EventRow {
  id: string;
  kind: string;
  entry_title: string | null;
  entry_url: string | null;
  feed_title: string | null;
  seconds: number | null;
  target_url: string | null;
}

async function events(): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reading_events ORDER BY id',
  ).all<EventRow>();
  return results;
}

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare('DELETE FROM reading_events').run();
});

describe('POST /api/events', () => {
  it('記事とフィードの中身を写して残す。同じ id は 1 件にする', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { title: '例のブログ' });
    const entryId = await seedEntry(env.DB, feedId, {
      title: '記事',
      url: 'https://example.com/1',
    });
    const body = {
      events: [
        { id: 'aaaaaaaa-1', kind: 'dwell', at: NOW, feedId, entryId, seconds: 42 },
        {
          id: 'aaaaaaaa-2',
          kind: 'link',
          at: NOW,
          feedId,
          entryId,
          url: 'https://other.example/x',
        },
        { id: 'aaaaaaaa-3', kind: 'open', at: NOW, feedId, entryId },
      ],
    };

    expect((await apiSend('POST', '/api/events', body)).status).toBe(200);
    expect((await apiSend('POST', '/api/events', body)).status).toBe(200);

    const rows = await events();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: 'dwell',
      seconds: 42,
      entry_title: '記事',
      entry_url: 'https://example.com/1',
      feed_title: '例のブログ',
    });
    expect(rows[1].target_url).toBe('https://other.example/x');
  });

  it('長すぎる URL は断らずに切り詰める（断ると outbox が同じ要求の記録ごと捨てる）', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed');
    const entryId = await seedEntry(env.DB, feedId, { url: 'https://example.com/1' });
    const url = `https://other.example/x?q=${'a'.repeat(3000)}`;
    const body = {
      events: [{ id: 'aaaaaaaa-1', kind: 'link', at: NOW, feedId, entryId, url }],
    };

    expect((await apiSend('POST', '/api/events', body)).status).toBe(200);
    const [row] = await events();
    expect(row.target_url).toBe(url.slice(0, 2048));
  });

  it('形の違うものは 400', async () => {
    const send = (event: unknown) => apiSend('POST', '/api/events', { events: [event] });
    expect((await send({ id: 'x', kind: 'dwell' })).status).toBe(400);
    expect(
      (
        await send({
          id: 'aaaaaaaa',
          kind: 'link',
          at: NOW,
          feedId: 1,
          entryId: 1,
          url: 'javascript:1',
        })
      ).status,
    ).toBe(400);
    expect(
      (await send({ id: 'aaaaaaaa', kind: 'like', at: NOW, feedId: 1, entryId: 1 })).status,
    ).toBe(400);
  });
});

describe('refreshSkimmedFeeds', () => {
  async function view(feedId: number, entryId: number, seconds: number, n: number) {
    await env.DB.prepare(
      `INSERT INTO reading_events (id, kind, at, feed_id, entry_id, seconds) VALUES (?, 'dwell', ?, ?, ?, ?)`,
    )
      .bind(`e-${feedId}-${entryId}-${n}`, NOW, feedId, entryId, seconds)
      .run();
  }

  it('表示した記事の大半が数秒で送られたフィードに印を付ける', async () => {
    const skimmed = await seedFeed(env.DB, 'https://skim.example.com/feed');
    const read = await seedFeed(env.DB, 'https://read.example.com/feed');
    for (let i = 0; i < SKIM_MIN_VIEWS; i += 1) {
      await view(skimmed, 1000 + i, 1, 0);
      await view(read, 2000 + i, 30, 0);
    }

    await refreshSkimmedFeeds(env.DB, NOW - 86_400);

    expect((await getFeedRow(env.DB, skimmed)).skimmed).toBe(1);
    expect((await getFeedRow(env.DB, read)).skimmed).toBe(0);
  });

  it('1 記事の表示が細切れでも、合計で読んでいれば送ったことにしない', async () => {
    const feedId = await seedFeed(env.DB, 'https://split.example.com/feed');
    for (let i = 0; i < SKIM_MIN_VIEWS; i += 1) {
      for (let n = 0; n < 4; n += 1) await view(feedId, 3000 + i, 2, n);
    }
    await refreshSkimmedFeeds(env.DB, NOW - 86_400);
    expect((await getFeedRow(env.DB, feedId)).skimmed).toBe(0);
  });

  it('件数が少ない・ピンを立てたフィードには付けない', async () => {
    const few = await seedFeed(env.DB, 'https://few.example.com/feed');
    await view(few, 1, 1, 0);
    const pinned = await seedFeed(env.DB, 'https://pinned.example.com/feed');
    const entryId = await seedEntry(env.DB, pinned, { url: 'https://pinned.example.com/1' });
    await seedPin(env.DB, 'https://pinned.example.com/1', 'ピン', entryId);
    for (let i = 0; i < SKIM_MIN_VIEWS; i += 1) await view(pinned, 4000 + i, 1, 0);

    await refreshSkimmedFeeds(env.DB, NOW - 86_400);

    expect((await getFeedRow(env.DB, few)).skimmed).toBe(0);
    expect((await getFeedRow(env.DB, pinned)).skimmed).toBe(0);
  });
});
