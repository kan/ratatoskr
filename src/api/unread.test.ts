import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EntriesResponse, ReadResponse } from '../../shared/types';
import { apiGet, apiJson, apiSend } from '../test/request';
import { getFeedRow, seedEntry, seedFeed, setReadSeq } from '../test/seed';

/**
 * 個別の記事を未読に戻す例外（entry_states）。
 * ウォーターマークを動かさずに 1 件だけ未読へ戻せること、
 * その 1 件が未読の一覧に戻ってくることを見る。
 */

async function unreadIds(feedId: number): Promise<number[]> {
  const body = await apiJson<EntriesResponse>(`/api/entries?feedId=${feedId}&unreadOnly=true`);
  return body.entries.map((entry) => entry.id);
}

describe('POST /api/entries/:id/unread', () => {
  it('既読の記事を 1 件だけ未読に戻す', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-mark.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, second);

    const response = await apiSend('POST', `/api/entries/${first}/unread`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadResponse;
    expect(body.feeds).toEqual([{ id: feedId, readSeq: second, unreadCount: 1 }]);

    expect(await unreadIds(feedId)).toEqual([first]);
    // ウォーターマークは動かさない。動かすと second まで巻き戻る
    expect((await getFeedRow(env.DB, feedId)).read_seq).toBe(second);
  });

  it('繰り返し送っても結果が変わらない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-idempotent.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, entryId);

    await apiSend('POST', `/api/entries/${entryId}/unread`);
    await apiSend('POST', `/api/entries/${entryId}/unread`);
    expect(await unreadIds(feedId)).toEqual([entryId]);
  });

  it('DELETE で既読に戻す', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-clear.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, entryId);

    await apiSend('POST', `/api/entries/${entryId}/unread`);
    const response = await apiSend('DELETE', `/api/entries/${entryId}/unread`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ReadResponse).feeds[0].unreadCount).toBe(0);
    expect(await unreadIds(feedId)).toEqual([]);
  });

  it('未読に戻した記事は既読化が追い越しても未読のまま残る', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-watermark.example.com/feed');
    const first = await seedEntry(env.DB, feedId);
    const second = await seedEntry(env.DB, feedId);

    await apiSend('POST', `/api/entries/${first}/unread`);
    // その後にフィード全体を既読にしても、例外の 1 件は残る
    await apiSend('POST', '/api/read', { marks: [{ feedId, watermark: second }] });
    expect(await unreadIds(feedId)).toEqual([first]);
  });

  it('存在しない記事は 404', async () => {
    const response = await apiSend('POST', '/api/entries/999999/unread');
    expect(response.status).toBe(404);
  });

  it('POST / DELETE 以外は受け付けない', async () => {
    const feedId = await seedFeed(env.DB, 'https://u-method.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    // GET /api/entries と紛らわしいパスなので、メソッドで取り違えないことを見ておく
    expect((await apiGet(`/api/entries/${entryId}/unread`)).status).toBe(404);
  });
});
