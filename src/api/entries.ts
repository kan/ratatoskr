import type { EntriesResponse } from '../../shared/types';
import { selectEntries } from '../db/entries';
import { json } from '../lib/errors';
import { boolParam, intParam, optionalIntParam } from '../lib/params';

/**
 * GET /api/entries
 *
 * 起動後に残りの記事を背景で引くための一括取得。
 * ページングは必ず sinceId で行う。オフセットは使わない
 * （取得中に新着が入ると重複・欠落するため。docs/API.md）。
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export async function entries(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sinceId = intParam(url, 'sinceId', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  const feedId = optionalIntParam(url, 'feedId', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const unreadOnly = boolParam(url, 'unreadOnly', true);
  const limit = intParam(url, 'limit', { default: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });

  // 続きの有無は 1 件多く引いて判定する。COUNT を別に投げない
  const rows = await selectEntries(env.DB, { sinceId, feedId, unreadOnly, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const body: EntriesResponse = {
    entries: page,
    nextSinceId: hasMore ? page[page.length - 1].id : null,
    hasMore,
  };
  return json(body);
}
