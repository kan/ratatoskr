import type { ReadResponse } from '../../shared/types';
import { deleteEntryUnread, insertEntryUnread, selectEntryFeedId } from '../db/entry_states';
import { selectFeedReadStates } from '../db/feeds';
import { ApiError, json } from '../lib/errors';

/**
 * POST /api/entries/:id/unread   — 個別の記事を未読に戻す
 * DELETE /api/entries/:id/unread — 未読に戻した記事を既読に戻す
 *
 * どちらもウォーターマークは動かさない。動かすとその記事より後ろの既読が
 * まとめて巻き戻る（docs/API.md）。例外は entry_states の行だけで表す。
 */
export async function setEntryUnread(
  env: Env,
  entryId: number,
  unread: boolean,
): Promise<Response> {
  const feedId = await selectEntryFeedId(env.DB, entryId);
  // 保持期間を過ぎて消えた記事に対する送信が来ることがある。存在は明示的に見る
  if (feedId === null) throw new ApiError('not_found', `記事 ${entryId} は存在しない`, 404);

  if (unread) {
    await insertEntryUnread(env.DB, entryId, Math.floor(Date.now() / 1000));
  } else {
    await deleteEntryUnread(env.DB, entryId);
  }

  // 未読数が変わるので、そのフィードの状態を返す
  const body: ReadResponse = { feeds: await selectFeedReadStates(env.DB, [feedId]) };
  return json(body);
}
