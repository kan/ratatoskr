import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { SyncResponse } from '../../shared/types';
import { apiJson } from '../test/request';
import { seedEntry, seedFeed, seedPin, setReadSeq } from '../test/seed';

describe('GET /api/sync', () => {
  it('entryCursor より後の記事だけを返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://s-new.example.com/feed');
    const known = await seedEntry(env.DB, feedId);
    const fresh = await seedEntry(env.DB, feedId);

    const body = await apiJson<SyncResponse>(`/api/sync?entryCursor=${known}`);
    expect(body.newEntries.map((entry) => entry.id)).toEqual([fresh]);
    expect(body.maxEntryId).toBe(fresh);
  });

  it('新着は未読とは限らないので既読の記事も返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://s-read.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);
    // 他端末が既に読んでいる状態
    await setReadSeq(env.DB, feedId, second);

    const body = await apiJson<SyncResponse>('/api/sync?entryCursor=0');
    expect(body.newEntries.map((entry) => entry.id)).toEqual([first, second]);
  });

  it('readSeq と未読数を載せたフィードを返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://s-feed.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, first);

    const body = await apiJson<SyncResponse>('/api/sync');
    const feed = body.feeds.find((candidate) => candidate.id === feedId);
    expect(feed).toMatchObject({ readSeq: first, unreadCount: 1 });
  });

  it('ピンを返す。削除の追跡はまだ無いので deletedPinIds は空', async () => {
    const pinId = await seedPin(env.DB, 'https://s-pin.example.com/article');

    const body = await apiJson<SyncResponse>('/api/sync?since=0');
    expect(body.pins.map((pin) => pin.id)).toEqual([pinId]);
    expect(body.deletedPinIds).toEqual([]);
  });

  it('パラメータが無くても動く', async () => {
    const body = await apiJson<SyncResponse>('/api/sync');
    expect(body.serverTime).toBeLessThan(1e11);
    expect(body.maxEntryId).toBe(0);
  });
});
