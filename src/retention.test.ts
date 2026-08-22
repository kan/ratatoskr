import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { purgeExpiredEntries } from './retention';
import {
  getEntryRows,
  seedEntry,
  seedEntryState,
  seedFeed,
  seedPin,
  setReadSeq,
} from './test/seed';

/**
 * 保持期間による記事削除（M9。docs/DESIGN.md §3「保持期間」）。
 *
 * 消してよいのは「既読・未ピン・古い」の 3 つが揃ったものだけ。1 つでも欠けた記事を
 * 消すと、画面には出ているのに実体が無い状態になるので、条件ごとに残ることを見る。
 */

const NOW = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
const DAY = 86_400;
/** 保持期間の外（40 日前） */
const OLD = NOW - 40 * DAY;
/** 保持期間の中（10 日前） */
const RECENT = NOW - 10 * DAY;

async function idsOf(feedId: number): Promise<number[]> {
  return (await getEntryRows(env.DB, feedId)).map((row) => row.id);
}

describe('purgeExpiredEntries', () => {
  it('既読で、ピンが無く、保持期間を過ぎた記事だけを消す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    // 期間を過ぎた既読記事。消える側なので id は要らない
    await seedEntry(env.DB, feedId, { storedAt: OLD });
    const recent = await seedEntry(env.DB, feedId, { storedAt: RECENT });
    const unread = await seedEntry(env.DB, feedId, { storedAt: OLD });
    // 既読は old と recent まで。unread はウォーターマークの外
    await setReadSeq(env.DB, feedId, recent);

    const summary = await purgeExpiredEntries(env, { now: NOW });

    expect(summary).toEqual({ deleted: 1, done: true });
    expect(await idsOf(feedId)).toEqual([recent, unread]);
  });

  it('手で未読に戻した記事は、既読の位置より前でも残す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const forced = await seedEntry(env.DB, feedId, { storedAt: OLD });
    const plain = await seedEntry(env.DB, feedId, { storedAt: OLD });
    await setReadSeq(env.DB, feedId, plain);
    // u で未読に戻した記事（entry_states の例外）。画面には未読として出ている
    await seedEntryState(env.DB, forced, true);

    await purgeExpiredEntries(env, { now: NOW });

    expect(await idsOf(feedId)).toEqual([forced]);
  });

  it('ピンの付いた記事は保持期間を過ぎても残す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const pinned = await seedEntry(env.DB, feedId, { storedAt: OLD });
    const plain = await seedEntry(env.DB, feedId, { storedAt: OLD });
    await setReadSeq(env.DB, feedId, plain);
    await seedPin(env.DB, 'https://example.com/pinned', 'ピンした記事', pinned);

    await purgeExpiredEntries(env, { now: NOW });

    expect(await idsOf(feedId)).toEqual([pinned]);
  });

  it('記事が消えてもピンは残る（entry_id が外れるだけ）', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const entryId = await seedEntry(env.DB, feedId, { storedAt: OLD });
    await setReadSeq(env.DB, feedId, entryId);
    // 別の記事へのピン。対象の記事にはピンが無いので消える
    const pinId = await seedPin(env.DB, 'https://example.com/other', '別の記事');

    await purgeExpiredEntries(env, { now: NOW });

    expect(await idsOf(feedId)).toEqual([]);
    const pin = await env.DB.prepare('SELECT entry_id FROM pins WHERE id = ?')
      .bind(pinId)
      .first<{ entry_id: number | null }>();
    expect(pin?.entry_id).toBeNull();
  });

  it('消した記事の未読例外も一緒に消える', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const entryId = await seedEntry(env.DB, feedId, { storedAt: OLD });
    await setReadSeq(env.DB, feedId, entryId);
    // 一度未読に戻して、また読んだ記事（unread = 0 の例外は消してよい）
    await seedEntryState(env.DB, entryId, false);

    await purgeExpiredEntries(env, { now: NOW });

    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM entry_states').first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  it('1 回の実行で消す件数を区切り、消し残しがあることを返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedEntry(env.DB, feedId, { storedAt: OLD }));
    await setReadSeq(env.DB, feedId, ids[ids.length - 1]);

    // 初回や長く放置した後は数万件が対象になる。cron の実行時間を使い切るより持ち越す
    const first = await purgeExpiredEntries(env, { now: NOW, maxPerRun: 3 });
    expect(first).toEqual({ deleted: 3, done: false });
    // 古いものから消える（id 昇順）
    expect(await idsOf(feedId)).toEqual(ids.slice(3));

    const second = await purgeExpiredEntries(env, { now: NOW, maxPerRun: 3 });
    expect(second).toEqual({ deleted: 2, done: true });
    expect(await idsOf(feedId)).toEqual([]);
  });

  it('消すものが無ければ何もしない', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml');
    await seedEntry(env.DB, feedId, { storedAt: RECENT });

    expect(await purgeExpiredEntries(env, { now: NOW })).toEqual({ deleted: 0, done: true });
  });
});
