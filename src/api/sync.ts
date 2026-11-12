import type { SyncResponse } from '../../shared/types';
import { selectFeeds } from '../db/feeds';
import { selectEntries, selectMaxEntryId, selectUpdatedEntries } from '../db/entries';
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
 *
 * since を使うのは、本文が後から変わった記事（updatedEntries）だけ。
 */

/** 1 回の sync で返す新着の上限。超えた分は次の sync で続きを返す */
export const MAX_NEW_ENTRIES = 1000;

/**
 * since からさかのぼって引く幅（秒）。
 *
 * body_updated_at を刻むのはクロールの Worker で、serverTime を決めるのはこの Worker。
 * 時計がわずかにずれていると、前回の serverTime より前の時刻が付いた書き込みが
 * 前回の応答に間に合わずに漏れる。重なった分は同じ記事が二度届くだけで、
 * クライアントは id で上書きするので害は無い
 */
export const UPDATED_OVERLAP_SECONDS = 60;

export async function sync(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const entryCursor = intParam(url, 'entryCursor', {
    default: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const since = intParam(url, 'since', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER });

  const [feeds, rows, updatedEntries, pins, maxEntryId] = await Promise.all([
    selectFeeds(env.DB),
    // 新着は未読とは限らない（他端末が既に読んでいる）ので絞らない。
    // 続きの有無は GET /api/entries と同じく 1 件多く引いて判定する
    selectEntries(env.DB, {
      sinceId: entryCursor,
      feedId: null,
      unreadOnly: false,
      limit: MAX_NEW_ENTRIES + 1,
    }),
    // 全文は記事を入れた後に埋まる（次のクロールまで持ち越すこともある）。
    // 新着だけを返すと、全文の前の本文を持っていった端末はそのまま取り残される。
    //
    // **件数で打ち切らない。** 打ち切って serverTime を戻すと、同じ秒に刻まれた記事
    // （全文取得を切ったときはフィードの全記事が同じ秒になる）が上限を超えた時点で、
    // 次の同期も同じ範囲を引き直して先へ進めなくなる。件数は上限が無くても小さい。
    // 全文が入るのは cron 1 回あたり予算の 20 件までで、切ったときに戻るのは要約
    selectUpdatedEntries(env.DB, {
      since: Math.max(0, since - UPDATED_OVERLAP_SECONDS),
      maxId: entryCursor,
    }),
    selectPins(env.DB),
    selectMaxEntryId(env.DB),
  ]);
  // 全ての問い合わせの後で決める。問い合わせ中に入った書き込みは、次の同期で
  // この時刻以降として拾われる
  const serverTime = Math.floor(Date.now() / 1000);

  // 1 回で返し切れなかった場合、maxEntryId をサーバの最大 id にすると、
  // クライアントがカーソルを返した範囲の先まで進めてしまい、間の記事を
  // 二度と取りに来られなくなる。返した最後の id で止めて次回に続きを渡す
  const hasMore = rows.length > MAX_NEW_ENTRIES;
  const newEntries = hasMore ? rows.slice(0, MAX_NEW_ENTRIES) : rows;
  const cursor = hasMore ? newEntries[newEntries.length - 1].id : maxEntryId;

  const body: SyncResponse = {
    serverTime,
    feeds,
    newEntries,
    updatedEntries,
    pins,
    // 削除されたピンは追跡できないので常に空。M6 で tombstone を足すまでの暫定
    deletedPinIds: [],
    maxEntryId: cursor,
  };
  return json(body);
}
