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
 * docs/API.md は「since 以降に変化した Feed / Pin のみ」を返す仕様だが、現在の
 * スキーマには feeds の更新時刻も pins の削除記録も無い。read_seq を動かすのは
 * 他端末なので last_fetched_at では代用できず、絞り込むと同期そのものが壊れる。
 * そのため今は全件返す。変更追跡は書き込みを実装する M4 / M6 で足す。
 * since は受け取るが、現時点では応答に影響しない。
 */

const MAX_NEW_ENTRIES = 1000;

export async function sync(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const entryCursor = intParam(url, 'entryCursor', {
    default: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  // 受け取るだけで今は使わない。クライアント側の実装を先に固められるようにする
  intParam(url, 'since', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER });

  const [feeds, newEntries, pins, maxEntryId] = await Promise.all([
    selectFeeds(env.DB),
    // 新着は未読とは限らない（他端末が既に読んでいることがある）ので絞らない
    selectEntries(env.DB, {
      sinceId: entryCursor,
      feedId: null,
      unreadOnly: false,
      limit: MAX_NEW_ENTRIES,
    }),
    selectPins(env.DB),
    selectMaxEntryId(env.DB),
  ]);

  const body: SyncResponse = {
    serverTime: Math.floor(Date.now() / 1000),
    feeds,
    newEntries,
    pins,
    // 削除されたピンは追跡できないので常に空。M6 で tombstone を足すまでの暫定
    deletedPinIds: [],
    maxEntryId,
  };
  return json(body);
}
