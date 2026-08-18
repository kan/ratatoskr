import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EntriesResponse, ReadResponse } from '../../shared/types';
import { apiJson, apiSend } from '../test/request';
import { getFeedRow, seedEntry, seedFeed, setReadSeq } from '../test/seed';

/**
 * 既読ウォーターマークの書き込み。見るのは「巻き戻らないこと」と
 * 「重複・順序入れ替えで壊れないこと」（CLAUDE.md のテスト方針）。
 */

async function postRead(marks: { feedId: number; watermark: number }[]): Promise<ReadResponse> {
  const response = await apiSend('POST', '/api/read', { marks });
  if (response.status !== 200) {
    throw new Error(`POST /api/read が ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ReadResponse;
}

describe('POST /api/read', () => {
  it('ウォーターマークを進めて未読数を返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://r-advance.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    await seedEntry(env.DB, feedId);

    const body = await postRead([{ feedId, watermark: first }]);
    expect(body.feeds).toEqual([{ id: feedId, readSeq: first, unreadCount: 1 }]);
  });

  it('手元より古いウォーターマークでは巻き戻らない', async () => {
    const feedId = await seedFeed(env.DB, 'https://r-rewind.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, second);

    // 遅れて届いた古い送信。MAX を取らないとここで既読が巻き戻る
    const body = await postRead([{ feedId, watermark: first }]);
    expect(body.feeds[0].readSeq).toBe(second);
    expect((await getFeedRow(env.DB, feedId)).read_seq).toBe(second);
  });

  it('同じ送信を繰り返しても、順序が入れ替わっても結果が変わらない', async () => {
    const feedId = await seedFeed(env.DB, 'https://r-idempotent.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);

    await postRead([{ feedId, watermark: second }]);
    await postRead([{ feedId, watermark: second }]);
    // 逆順で届いた再送
    await postRead([{ feedId, watermark: first }]);

    const body = await postRead([{ feedId, watermark: second }]);
    expect(body.feeds[0]).toEqual({ id: feedId, readSeq: second, unreadCount: 0 });
  });

  it('複数フィードをまとめて更新する', async () => {
    const one = await seedFeed(env.DB, 'https://r-multi-1.example.com/feed');
    const two = await seedFeed(env.DB, 'https://r-multi-2.example.com/feed');
    const oneEntry = await seedEntry(env.DB, one);
    const twoEntry = await seedEntry(env.DB, two);

    const body = await postRead([
      { feedId: one, watermark: oneEntry },
      { feedId: two, watermark: twoEntry },
    ]);
    expect(body.feeds).toEqual([
      { id: one, readSeq: oneEntry, unreadCount: 0 },
      { id: two, readSeq: twoEntry, unreadCount: 0 },
    ]);
  });

  it('既読にした記事は未読の一覧から消える', async () => {
    const feedId = await seedFeed(env.DB, 'https://r-list.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);

    await postRead([{ feedId, watermark: first }]);
    const body = await apiJson<EntriesResponse>(`/api/entries?feedId=${feedId}&unreadOnly=true`);
    expect(body.entries.map((entry) => entry.id)).toEqual([second]);
  });

  it('存在しないフィードへの送信は黙って捨てる', async () => {
    // 他端末で購読を消した後に届いた送信。失敗にすると outbox が詰まる
    const body = await postRead([{ feedId: 999999, watermark: 1 }]);
    expect(body.feeds).toEqual([]);
  });

  it('壊れたボディは 400 で弾く', async () => {
    expect((await apiSend('POST', '/api/read', { marks: 'まとめて' })).status).toBe(400);
    expect((await apiSend('POST', '/api/read', { marks: [{ feedId: 1 }] })).status).toBe(400);
    expect(
      (await apiSend('POST', '/api/read', { marks: [{ feedId: 0, watermark: 1 }] })).status,
    ).toBe(400);
    expect(
      (await apiSend('POST', '/api/read', { marks: [{ feedId: 1, watermark: -1 }] })).status,
    ).toBe(400);
    expect((await apiSend('POST', '/api/read')).status).toBe(400);
  });
});
