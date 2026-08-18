/**
 * 取得間隔の適応制御と失敗バックオフ（docs/DESIGN.md §5）。
 * 純関数だけを置く。時刻も DB もここでは触らない。
 */

/**
 * 更新があったフィードはこの間隔に戻す。
 *
 * feeds.fetch_interval の DB 既定値（900）はフィードを登録した直後にしか効かない。
 * 初回の取得でここの値に上書きされるので、実運用の間隔はこの定数が決める。
 */
export const INITIAL_INTERVAL = 3600; // 1 時間
/** 更新が無いフィードを間引く上限 */
export const MAX_INTERVAL = 21600; // 6 時間
const INTERVAL_GROWTH = 1.5;

/** 失敗時のバックオフ上限 */
export const MAX_BACKOFF = 86400; // 24 時間
/** これを超えたら disabled にして UI に警告を出す */
export const MAX_CONSECUTIVE_FAILURES = 20;

/** 新着があった場合。次も来ると仮定して最短間隔に戻す */
export function intervalAfterUpdate(): number {
  return INITIAL_INTERVAL;
}

/** 新着が無かった場合。相手のサーバに通う頻度を落としていく */
export function intervalAfterNoUpdate(current: number): number {
  const grown = Math.floor(current * INTERVAL_GROWTH);
  return Math.min(Math.max(grown, INITIAL_INTERVAL), MAX_INTERVAL);
}

/** 失敗時の待ち時間。failures は今回の失敗を含めた連続失敗回数（1 始まり） */
export function backoffAfterFailure(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  // 2^n は 2^30 を超えると Infinity 手前まで伸びるので、先に指数側を頭打ちにする
  const capped = Math.min(exponent, 20);
  return Math.min(INITIAL_INTERVAL * 2 ** capped, MAX_BACKOFF);
}

export function shouldDisable(failures: number): boolean {
  return failures > MAX_CONSECUTIVE_FAILURES;
}
