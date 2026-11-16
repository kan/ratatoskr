import { REPOSITORY_URL, type FeedErrorKind } from '../../shared/types';
import { errorMessage } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { decodeMarkup } from './charset';
import { RobotsDisallowedError } from './robots';

/**
 * フィードの取得。条件付き GET と content_hash による差分判定までを担当し、
 * パースやスケジューリングは呼び出し側に任せる。
 */

/**
 * cron 1 回で外部へ追加で取りに行ける回数。フィード本体の取得（1 フィード 1 回）とは別に、
 * 記事ページの取得（全文取得）と埋め込みの解決（X の oEmbed）がここから引かれる。
 *
 * 1 リクエストあたりのサブリクエスト上限があるので、フィード本体 20 本の上に
 * 無制限に積み上げられない（docs/DESIGN.md §5）。
 */
export interface FetchBudget {
  remaining: number;
}

/**
 * 取りに行く前に枠を確保する。**await を挟まずに読んで引く。**
 * クロールはフィードを並列に回すので、取得を待ってから引くと、同じ残りを
 * 複数のフィードが同時に読んで上限を超える。
 *
 * @returns 実際に確保できた数（0 なら取りに行かない）
 */
export function reserveBudget(budget: FetchBudget, want: number): number {
  const granted = Math.min(want, budget.remaining);
  if (granted <= 0) return 0;
  budget.remaining -= granted;
  return granted;
}

/** 使わなかった枠を返す。取りに行って失敗した分は返さない（叩き続けないため） */
export function releaseBudget(budget: FetchBudget, unused: number): void {
  if (unused > 0) budget.remaining += unused;
}

/**
 * 認証の要らない JSON の API を 1 本引く。**引けなければ全て null に倒す。**
 *
 * 名乗りと打ち切りは上の定数を共有する（片方だけ緩めることに意味は無い）。
 * ネットワークの失敗・エラー応答・壊れた JSON をどれも同じ「無かった」に畳むのは、
 * **呼び出し側がどれも同じ扱いをする**ため——記事 1 本の埋め込みや投稿 1 件が
 * 引けなくても、フィードの取得自体は成功している。`feeds.last_error` に書くと
 * フィードが壊れているように見えるので書かない。
 *
 * @param label 引けなかったときにログへ残す名前
 * @param clientError 4xx（408 と 429 を除く）のときに null の代わりに返す値。
 *   **待っても直らない失敗を、一時的な失敗と分けたい呼び出し側だけが渡す**
 *   （Bluesky の返信。src/crawler/bluesky.ts の fetchSelfReplies）
 */
export async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
  clientError: unknown = null,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`${label}の取得に失敗`, url, describeNetworkError(err).message);
    return null;
  }
  if (!response.ok) return isPermanentClientError(response.status) ? clientError : null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 408（打ち切り）と 429（流量の制限）は時間を置けば通るので、4xx でも一時的に数える */
function isPermanentClientError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

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
  | {
      kind: 'error';
      message: string;
      reason: FeedErrorKind;
      /**
       * 相手が `Retry-After` で指定した待ち時間（秒）。429 / 503 のときだけ付く（issue #39）。
       * 次の取得時刻をこれより前にしない（src/crawler/index.ts の recordFailure）
       */
      retryAfter?: number;
    };

export interface FetchTarget {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
}

/**
 * 取得の共通設定。フィード本体の取得（ここ）と、購読追加時の検出（discover.ts）で
 * 同じ名乗り・同じ上限を使う。片方だけ緩めることに意味は無い。
 *
 * 例外は下の DISCOVER_ANCESTOR_BUDGET_MS だけで、あれは当てが外れたときの
 * 保険に付ける締め切りなので、本命と同じだけ待たせない。
 */
export const USER_AGENT = `Ratatoskr/0.1 (+${REPOSITORY_URL})`;
// 遅いサーバに cron 全体を引きずられないための打ち切り。
// fetch の待ち時間は CPU 時間に計上されないが、実行時間の上限には効く
export const TIMEOUT_MS = 15_000;

/**
 * 上の階層を遡って探すとき（discover.ts）に、**遡り全体で**使える時間。
 *
 * 段ごとに TIMEOUT_MS を持たせると、全滅したときに段数ぶん積み上がる。遡りは
 * 本命が外れたときの保険なので、購読の追加が返らなくなる方が損が大きい。
 * 締め切りを 1 つ共有すれば、何段あっても待ちはここで頭打ちになる
 */
export const DISCOVER_ANCESTOR_BUDGET_MS = 5_000;
// 想定外に巨大なフィードで DB とメモリを埋めないための上限
export const MAX_BYTES = 4 * 1024 * 1024;

const ACCEPT =
  'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

type BoundedRead =
  { kind: 'ok'; body: string } | { kind: 'error'; message: string; reason: FeedErrorKind };

/**
 * 大きすぎる応答を弾き、HTML / XML を宣言された文字コードで読む（issue #35 / #36 / #37）。
 * フィード本体・記事ページ・購読の検出の全てがここを通る。
 *
 * 以前は `response.text()` で UTF-8 決め打ちで読んでいたので、Shift_JIS や EUC-JP の
 * フィードの記事や、記事ページの全文が化けたまま入っていた。判定は
 * src/crawler/charset.ts に任せる（JSON の API を返す取り込み口も通るが、JSON は
 * そちらで UTF-8 に決め打つ）。
 *
 * **上限（MAX_BYTES）はバイト数で見る。** 申告（content-length）で先に切り、申告の無い
 * サーバのためには**読みながら**見て、超えた時点で読むのをやめる。読み切ってから測ると、
 * 申告の無い巨大な応答を丸ごとメモリに載せてしまう（全文取得は複数のページを並列に読む）
 */
export async function readBoundedMarkup(response: Response): Promise<BoundedRead> {
  const declaredLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return { kind: 'error', message: `応答が大きすぎる: ${declaredLength} bytes`, reason: 'other' };
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return { kind: 'ok', body: '' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return {
          kind: 'error',
          message: `応答が大きすぎる: ${MAX_BYTES} bytes を超えた`,
          reason: 'other',
        };
      }
    }
  } catch (err) {
    return { ...describeNetworkError(err), kind: 'error' };
  }
  const contentType = response.headers.get('content-type');
  return { kind: 'ok', body: decodeMarkup(concatBytes(chunks, total), contentType) };
}

/** 読んだ塊を 1 つのバイト列につなぐ（src/crawler/page-title.ts の readHead も使う） */
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * fetch が投げた例外を、人が読める文言と分類に落とす。
 *
 * workerd は接続できない相手（消えたドメインを含む）を
 * `internal error; reference = ...` と報告する。そのまま last_error に入れると
 * 購読管理画面に意味の通らない文字列が並ぶので、ここで噛み砕く。
 *
 * @param timeoutMs 打ち切りに使った時間。TIMEOUT_MS と違う時間で打ち切った
 *   呼び出し側（src/crawler/page-title.ts）が、文言の秒数を合わせるために渡す
 */
export function describeNetworkError(
  err: unknown,
  timeoutMs = TIMEOUT_MS,
): { message: string; reason: FeedErrorKind } {
  const timedOut = `応答が無い（${timeoutMs / 1000} 秒で打ち切り）`;
  // 打ち切りは名前で判る。AbortSignal.timeout は TimeoutError を投げると
  // 仕様で決まっているので、文言が変わっても取り違えない
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return { message: timedOut, reason: 'timeout' };
  }

  // 以下は workerd の文言に頼るしかない。取りこぼしても other として記録は残り、
  // 一括解除の対象から外れる（消しすぎない側に倒れる）だけで済ませてある
  const raw = errorMessage(err);
  if (raw.includes('aborted due to timeout')) {
    return { message: timedOut, reason: 'timeout' };
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

/**
 * 429 / 503 の `Retry-After` を、今から何秒待てばよいかに直す（RFC 9110 §10.2.3）。
 * 秒数と HTTP 日付の両方を受ける。付いていない・読めない・過去の日付なら null
 */
export function rateLimitDelay(response: Response, now: number): number | null {
  if (response.status !== 429 && response.status !== 503) return null;
  return parseRetryAfter(response.headers.get('retry-after'), now);
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delay = Math.ceil(date / 1000) - now;
  return delay > 0 ? delay : null;
}

export type ArticlePageOutcome =
  | { kind: 'ok'; html: string }
  /** 記事ページが消えている。取り直しても結果は変わらない */
  | { kind: 'gone' }
  /** robots.txt に禁じられている（issue #39）。取りに行っていない */
  | { kind: 'disallowed' }
  /** 一時的な失敗。次の機会に回す */
  | { kind: 'retry' };

/** 記事ページ（とリンク先のページ。src/crawler/page-title.ts）を取りに行くときの Accept */
export const ARTICLE_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';

/**
 * 記事ページを 1 枚取る（全文取得。src/crawler/fulltext.ts と src/crawler/idolmaster.ts）。
 *
 * 取得の作法（名乗り、打ち切り、ステータスの分け方、大きさの上限）を 1 か所に置く。
 * 片方だけ変えると、同じ記事ページの取得なのに経路によって振る舞いがずれる
 */
export async function fetchArticlePage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ArticlePageOutcome> {
  // 条件付き GET は使わない。記事ページは 1 度しか取りに行かないので、
  // etag を覚えておく先も、覚えておく意味も無い
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: ARTICLE_ACCEPT },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof RobotsDisallowedError) return { kind: 'disallowed' };
    // 記事 1 本が取れなくてもフィードの取得は成功している。
    // feeds.last_error に書くとフィード自体が壊れているように見えるので書かない
    console.warn('全文の取得に失敗', url, describeNetworkError(err).message);
    return { kind: 'retry' };
  }
  // 404 / 410 は何度引いても同じ。それ以外（5xx や 429）は時間を置けば直りうる
  if (response.status === 404 || response.status === 410) return { kind: 'gone' };
  if (!response.ok) return { kind: 'retry' };

  const read = await readBoundedMarkup(response);
  return read.kind === 'ok' ? { kind: 'ok', html: read.body } : { kind: 'retry' };
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
    // 取得定義の一覧のページ（issue #40）は robots.txt を見る。購読を消してよい失敗では
    // ない（サイトは生きている）ので、一括解除の対象にならない other に分ける
    if (err instanceof RobotsDisallowedError) {
      return { kind: 'error', message: err.message, reason: 'other' };
    }
    return { ...describeNetworkError(err), kind: 'error' };
  }

  if (response.status === 304) return { kind: 'notModified' };
  if (!response.ok) {
    const failure = { ...describeHttpStatus(response), kind: 'error' as const };
    const retryAfter = rateLimitDelay(response, Math.floor(Date.now() / 1000));
    return retryAfter === null ? failure : { ...failure, retryAfter };
  }

  // content_hash は戻した後の文字列から作る。読み方を変えた最初の 1 回だけ、
  // UTF-8 以外のフィードは前回と食い違って取り込み直しになるが、INSERT OR IGNORE で
  // 吸収される（guid / link が ASCII の URL なら guid_hash は変わらない。日本語を
  // 生のまま含む URL や、guid と link の両方を欠く記事だけは、1 回だけ二重に入る）
  const read = await readBoundedMarkup(response);
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
