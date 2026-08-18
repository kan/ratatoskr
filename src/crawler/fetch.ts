import type { FeedErrorKind } from '../../shared/types';
import { errorMessage } from '../lib/errors';
import { sha256Hex } from '../lib/hash';

/**
 * フィードの取得。条件付き GET と content_hash による差分判定までを担当し、
 * パースやスケジューリングは呼び出し側に任せる。
 */

export type FetchOutcome =
  /** 304。本文を読まずに終わり */
  | { kind: 'notModified' }
  /** 200 だが中身が前回と同一（304 を返さないサーバ向け） */
  | { kind: 'unchanged' }
  | {
      kind: 'fetched';
      body: string;
      etag: string | null;
      lastModified: string | null;
      contentHash: string;
    }
  | { kind: 'error'; message: string; reason: FeedErrorKind };

export interface FetchTarget {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
}

/**
 * 取得の共通設定。フィード本体の取得（ここ）と、購読追加時の検出（discover.ts）で
 * 同じ名乗り・同じ上限を使う。片方だけ緩めることに意味は無い。
 */
export const USER_AGENT = 'Ratatoskr/0.1 (+https://github.com/kan/ratatoskr)';
// 遅いサーバに cron 全体を引きずられないための打ち切り。
// fetch の待ち時間は CPU 時間に計上されないが、実行時間の上限には効く
export const TIMEOUT_MS = 15_000;
// 想定外に巨大なフィードで DB とメモリを埋めないための上限
export const MAX_BYTES = 4 * 1024 * 1024;

const ACCEPT =
  'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/**
 * 大きすぎる応答を弾いて本文を読む。
 * 申告（content-length）で先に切り、申告の無いサーバのために読んだ後でも見る。
 */
export async function readBoundedText(
  response: Response,
): Promise<
  { kind: 'ok'; body: string } | { kind: 'error'; message: string; reason: FeedErrorKind }
> {
  const declaredLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return { kind: 'error', message: `応答が大きすぎる: ${declaredLength} bytes`, reason: 'other' };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return { ...describeNetworkError(err), kind: 'error' };
  }
  if (body.length > MAX_BYTES) {
    return { kind: 'error', message: `応答が大きすぎる: ${body.length} 文字`, reason: 'other' };
  }
  return { kind: 'ok', body };
}

/**
 * fetch が投げた例外を、人が読める文言と分類に落とす。
 *
 * workerd は接続できない相手（消えたドメインを含む）を
 * `internal error; reference = ...` と報告する。そのまま last_error に入れると
 * 購読管理画面に意味の通らない文字列が並ぶので、ここで噛み砕く。
 */
export function describeNetworkError(err: unknown): { message: string; reason: FeedErrorKind } {
  // 打ち切りは名前で判る。AbortSignal.timeout は TimeoutError を投げると
  // 仕様で決まっているので、文言が変わっても取り違えない
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return { message: `応答が無い（${TIMEOUT_MS / 1000} 秒で打ち切り）`, reason: 'timeout' };
  }

  // 以下は workerd の文言に頼るしかない。取りこぼしても other として記録は残り、
  // 一括解除の対象から外れる（消しすぎない側に倒れる）だけで済ませてある
  const raw = errorMessage(err);
  if (raw.includes('aborted due to timeout')) {
    return { message: `応答が無い（${TIMEOUT_MS / 1000} 秒で打ち切り）`, reason: 'timeout' };
  }
  if (raw.includes('Network connection lost')) {
    return { message: '接続が途中で切れた', reason: 'connection_lost' };
  }
  if (raw.includes('internal error')) {
    return { message: '接続できない（ドメインが消えている可能性）', reason: 'unreachable' };
  }
  return { message: `取得に失敗: ${raw}`, reason: 'other' };
}

/** HTTP のステータスから分類する。4xx は直しようがなく、5xx は時間を置けば直りうる */
function describeHttpStatus(response: Response): { message: string; reason: FeedErrorKind } {
  const message = `HTTP ${response.status} ${response.statusText}`.trim();
  if (response.status === 404 || response.status === 410) return { message, reason: 'not_found' };
  if (response.status === 401 || response.status === 403) return { message, reason: 'forbidden' };
  if (response.status >= 500) return { message, reason: 'server_error' };
  return { message, reason: 'other' };
}

export async function fetchFeed(
  target: FetchTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const headers = new Headers({ 'user-agent': USER_AGENT, accept: ACCEPT });
  // 相手のサーバへの礼儀であり、こちらの実行時間も減る（docs/DESIGN.md §5）
  if (target.etag !== null) headers.set('if-none-match', target.etag);
  if (target.lastModified !== null) headers.set('if-modified-since', target.lastModified);

  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ...describeNetworkError(err), kind: 'error' };
  }

  if (response.status === 304) return { kind: 'notModified' };
  if (!response.ok) return { ...describeHttpStatus(response), kind: 'error' };

  const read = await readBoundedText(response);
  if (read.kind === 'error') return read;
  const body = read.body;

  const contentHash = await sha256Hex(body);
  if (target.contentHash !== null && target.contentHash === contentHash) {
    return { kind: 'unchanged' };
  }

  return {
    kind: 'fetched',
    body,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    contentHash,
  };
}
