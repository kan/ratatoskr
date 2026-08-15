import type { SyncResponse } from '../../shared/types';
import { selectFeeds } from '../db/feeds';
import { selectEntries, selectMaxEntryId } from '../db/entries';
import { selectPins } from '../db/pins';
import { json } from '../lib/errors';
import { intParam } from '../lib/params';

/**
 * GET /api/sync
 *
 * 複数端末間の差分同期。起動後の定期ポーリングと、タブがフォアグラウンドに
 * 戻ったときに叩く。クライアントは受け取った readSeq を Math.max でマージする。
 *
 * feeds と pins は全件返す。現在のスキーマには feeds の更新時刻も pins の削除記録も
 * 無く、read_seq を動かすのは他端末なので last_fetched_at では代用できない。
 * 中途半端に絞り込むと同期そのものが壊れるため、変更追跡は書き込みを実装する
 * M4 / M6 で足す（docs/API.md の「feeds と pins を全件返している理由」）。
 * since は受け取るが、それまでは応答に影響しない。
 */

/** 1 回の sync で返す新着の上限。超えた分は次の sync で続きを返す */
export const MAX_NEW_ENTRIES = 1000;

export async function sync(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const entryCursor = intParam(url, 'entryCursor', {
    default: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  // 受け取るだけで今は使わない。クライアント側の実装を先に固められるようにする
  intParam(url, 'since', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER });

  const [feeds, rows, pins, maxEntryId] = await Promise.all([
    selectFeeds(env.DB),
    // 新着は未読とは限らない（他端末が既に読んでいることがある）ので絞らない。
    // 続きの有無は GET /api/entries と同じく 1 件多く引いて判定する
    selectEntries(env.DB, {
      sinceId: entryCursor,
      feedId: null,
      unreadOnly: false,
      limit: MAX_NEW_ENTRIES + 1,
    }),
    selectPins(env.DB),
    selectMaxEntryId(env.DB),
  ]);

  // 1 回で返し切れなかった場合、maxEntryId をサーバの最大 id にすると、
  // クライアントがカーソルを返した範囲の先まで進めてしまい、間の記事を
  // 二度と取りに来られなくなる。返した最後の id で止めて次回に続きを渡す
  const hasMore = rows.length > MAX_NEW_ENTRIES;
  const newEntries = hasMore ? rows.slice(0, MAX_NEW_ENTRIES) : rows;
  const cursor = hasMore ? newEntries[newEntries.length - 1].id : maxEntryId;

  const body: SyncResponse = {
    serverTime: Math.floor(Date.now() / 1000),
    feeds,
    newEntries,
    pins,
    // 削除されたピンは追跡できないので常に空。M6 で tombstone を足すまでの暫定
    deletedPinIds: [],
    maxEntryId: cursor,
  };
  return json(body);
}
