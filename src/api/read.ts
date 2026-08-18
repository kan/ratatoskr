import type { ReadMark, ReadResponse } from '../../shared/types';
import { applyReadMarks, selectFeedReadStates } from '../db/feeds';
import { badRequest, readJsonBody } from '../lib/body';
import { json } from '../lib/errors';

/**
 * POST /api/read
 *
 * 既読ウォーターマークの更新。クライアントの outbox からまとめて送られる。
 * 冪等なので、重複しても順序が入れ替わっても結果は変わらない（db/feeds.ts の MAX）。
 */

/** 1 リクエストで受ける最大件数。購読数を上回る marks は送られてこない */
const MAX_MARKS = 500;

function parseMarks(body: unknown): ReadMark[] {
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const marks = (body as { marks?: unknown }).marks;
  if (!Array.isArray(marks)) badRequest('marks は配列で送る');
  if (marks.length > MAX_MARKS) badRequest(`marks は ${MAX_MARKS} 件までで送る`);

  return marks.map((mark) => {
    if (typeof mark !== 'object' || mark === null) badRequest('marks の要素はオブジェクトで送る');
    const { feedId, watermark } = mark as { feedId?: unknown; watermark?: unknown };
    if (!Number.isSafeInteger(feedId) || (feedId as number) < 1) {
      badRequest('feedId は 1 以上の整数で送る');
    }
    if (!Number.isSafeInteger(watermark) || (watermark as number) < 0) {
      badRequest('watermark は 0 以上の整数で送る');
    }
    return { feedId: feedId as number, watermark: watermark as number };
  });
}

export async function read(request: Request, env: Env): Promise<Response> {
  const marks = parseMarks(await readJsonBody(request));
  await applyReadMarks(env.DB, marks);

  // 同じフィードが複数回来ることがある（outbox がまとめ損ねた場合）ので id は重複を除く
  const ids = [...new Set(marks.map((mark) => mark.feedId))];
  const body: ReadResponse = { feeds: await selectFeedReadStates(env.DB, ids) };
  return json(body);
}
