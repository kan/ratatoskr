import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncResponse } from '../../shared/types';
import { updateFullBodies } from '../db/entries';
import { MAX_NEW_ENTRIES, UPDATED_OVERLAP_SECONDS } from './sync';
import { apiJson } from '../test/request';
import {
  getEntryRows,
  resetDb,
  seedEntry,
  seedFeed,
  seedManyEntries,
  seedPin,
  setReadSeq,
} from '../test/seed';

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

  it('1 回で返し切れないときはカーソルを返した範囲で止める', async () => {
    const feedId = await seedFeed(env.DB, 'https://s-many.example.com/feed');
    await seedManyEntries(env.DB, feedId, MAX_NEW_ENTRIES + 1);

    const body = await apiJson<SyncResponse>('/api/sync?entryCursor=0');
    expect(body.newEntries).toHaveLength(MAX_NEW_ENTRIES);
    // サーバの最大 id ではなく、実際に返した最後の id を返す。
    // ここを進めすぎると、間の記事をクライアントが二度と取りに来られない
    expect(body.maxEntryId).toBe(body.newEntries[MAX_NEW_ENTRIES - 1].id);

    const next = await apiJson<SyncResponse>(`/api/sync?entryCursor=${body.maxEntryId}`);
    expect(next.newEntries).toHaveLength(1);
  });

  it('パラメータが無くても動く', async () => {
    const body = await apiJson<SyncResponse>('/api/sync');
    expect(body.serverTime).toBeLessThan(1e11);
    expect(body.maxEntryId).toBe(0);
  });
});

/**
 * 本文が後から変わった記事（updatedEntries）。
 *
 * 全文は記事を入れた後に埋まるので、その間に同期した端末は全文の前の本文を持っていく。
 * 新着（entryCursor より後）だけを返すと、その端末は全文に追いつけない。
 */
describe('GET /api/sync の updatedEntries', () => {
  beforeEach(() => resetDb(env.DB));

  /** 同期 1 回ぶん。前回の応答を渡すと、クライアントと同じくカーソルと時刻を送り返す */
  async function syncAfter(previous: SyncResponse): Promise<SyncResponse> {
    return apiJson<SyncResponse>(
      `/api/sync?entryCursor=${previous.maxEntryId}&since=${previous.serverTime}`,
    );
  }

  async function setBodyUpdatedAt(id: number, at: number): Promise<void> {
    await env.DB.prepare('UPDATE entries SET body_updated_at = ? WHERE id = ?').bind(at, id).run();
  }

  it('同期で持っていった後に全文が入った記事を、全文で届け直す', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-fill.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId, { body: 'https://example.com/plain' });

    // 全文の前に同期が走り、要約を持っていく
    const first = await apiJson<SyncResponse>('/api/sync');
    expect(first.newEntries.map((entry) => entry.id)).toEqual([entryId]);

    await updateFullBodies(env.DB, [{ id: entryId, fullBody: '<p>全文</p>' }]);

    const second = await syncAfter(first);
    expect(second.newEntries).toEqual([]);
    expect(second.updatedEntries).toMatchObject([{ id: entryId, body: '<p>全文</p>' }]);
  });

  it('採らなかった印（空文字）では届け直さない。読み出しは要約のまま変わらない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-reject.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    const first = await apiJson<SyncResponse>('/api/sync');

    await updateFullBodies(env.DB, [{ id: entryId, fullBody: '' }]);

    expect((await syncAfter(first)).updatedEntries).toEqual([]);
  });

  it('既読の記事は届け直さない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-read.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    const first = await apiJson<SyncResponse>('/api/sync');

    await updateFullBodies(env.DB, [{ id: entryId, fullBody: '<p>全文</p>' }]);
    await setReadSeq(env.DB, feedId, entryId);

    expect((await syncAfter(first)).updatedEntries).toEqual([]);
  });

  it('entryCursor より後の記事は新着として届くので、二重に返さない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-new.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    await updateFullBodies(env.DB, [{ id: entryId, fullBody: '<p>全文</p>' }]);

    const body = await apiJson<SyncResponse>('/api/sync?entryCursor=0&since=0');
    expect(body.newEntries).toMatchObject([{ id: entryId, body: '<p>全文</p>' }]);
    expect(body.updatedEntries).toEqual([]);
  });

  it('前回の同期より十分前に変わった記事は返さない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-old.example.com/feed');
    const old = await seedEntry(env.DB, feedId);
    const recent = await seedEntry(env.DB, feedId);
    const since = 1_000_000;
    await setBodyUpdatedAt(old, since - UPDATED_OVERLAP_SECONDS - 1);
    // 時計のずれを見込んで、since より少し前に刻まれたものは拾う
    await setBodyUpdatedAt(recent, since - UPDATED_OVERLAP_SECONDS);

    const body = await apiJson<SyncResponse>(`/api/sync?entryCursor=${recent}&since=${since}`);
    expect(body.updatedEntries.map((entry) => entry.id)).toEqual([recent]);
  });

  it('同じ秒に刻まれた記事が多くても、1 回で全て返して since を先へ進める', async () => {
    // 全文取得を切ると、フィードの全記事に同じ時刻が刻まれる（CLEAR_FULL_BODIES）。
    // 件数で打ち切って serverTime を戻す形にすると、次の同期も同じ範囲を引き直して
    // 先へ進めなくなる
    const feedId = await seedFeed(env.DB, 'https://u-many.example.com/feed');
    const count = 500;
    await seedManyEntries(env.DB, feedId, count);
    const since = 1_000_000;
    await env.DB.prepare('UPDATE entries SET body_updated_at = ? WHERE feed_id = ?')
      .bind(since, feedId)
      .run();
    const ids = (await getEntryRows(env.DB, feedId)).map((row) => row.id);

    const body = await apiJson<SyncResponse>(
      `/api/sync?entryCursor=${ids[ids.length - 1]}&since=${since}`,
    );
    expect(body.updatedEntries).toHaveLength(count);
    expect(body.serverTime).toBeGreaterThan(since);
  });
});
