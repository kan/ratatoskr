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
  | { kind: 'error'; message: string };

export interface FetchTarget {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
}

const USER_AGENT = 'Ratatoskr/0.1 (+https://github.com/kan/ratatoskr)';
const ACCEPT =
  'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';
// 遅いサーバに cron 全体を引きずられないための打ち切り。
// fetch の待ち時間は CPU 時間に計上されないが、実行時間の上限には効く
const TIMEOUT_MS = 15_000;
// 想定外に巨大なフィードで DB とメモリを埋めないための上限
const MAX_BYTES = 4 * 1024 * 1024;

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
    return { kind: 'error', message: `取得に失敗: ${errorMessage(err)}` };
  }

  if (response.status === 304) return { kind: 'notModified' };
  if (!response.ok) {
    return { kind: 'error', message: `HTTP ${response.status} ${response.statusText}`.trim() };
  }

  const declaredLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return { kind: 'error', message: `フィードが大きすぎる: ${declaredLength} bytes` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return { kind: 'error', message: `本文の読み出しに失敗: ${errorMessage(err)}` };
  }
  if (body.length > MAX_BYTES) {
    return { kind: 'error', message: `フィードが大きすぎる: ${body.length} 文字` };
  }

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
