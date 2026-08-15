/**
 * feeds に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 * ここではクロールが使う分だけを定義する。読み取り API 用は M2 で足す。
 */

/** クローラが 1 フィードを処理するのに必要な列だけを引く */
export interface CrawlTarget {
  id: number;
  url: string;
  title: string;
  siteUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  fetchInterval: number;
  consecutiveFailures: number;
}

interface CrawlTargetRow {
  id: number;
  url: string;
  title: string;
  site_url: string | null;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  fetch_interval: number;
  consecutive_failures: number;
}

function toCrawlTarget(row: CrawlTargetRow): CrawlTarget {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    siteUrl: row.site_url,
    etag: row.etag,
    lastModified: row.last_modified,
    contentHash: row.content_hash,
    fetchInterval: row.fetch_interval,
    consecutiveFailures: row.consecutive_failures,
  };
}

const CRAWL_COLUMNS = `id, url, title, site_url, etag, last_modified, content_hash,
         fetch_interval, consecutive_failures`;

/**
 * 期限が来たフィードを古い順に取る。LIMIT は必ず付ける
 * （1 リクエストあたりのサブリクエスト上限。docs/DESIGN.md §5）。
 */
export async function selectCrawlTargets(
  db: D1Database,
  now: number,
  limit: number,
): Promise<CrawlTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CRAWL_COLUMNS}
         FROM feeds
        WHERE disabled = 0 AND next_fetch_at <= ?
        ORDER BY next_fetch_at
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<CrawlTargetRow>();
  return results.map(toCrawlTarget);
}

/** 手動クロール（M5 の POST /api/feeds/:id/fetch）や運用時の指名取得に使う */
export async function selectCrawlTargetsByIds(
  db: D1Database,
  ids: number[],
): Promise<CrawlTarget[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT ${CRAWL_COLUMNS} FROM feeds WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<CrawlTargetRow>();
  return results.map(toCrawlTarget);
}

export interface FetchSuccessParams {
  id: number;
  now: number;
  nextFetchAt: number;
  fetchInterval: number;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  /** フィードが名乗るタイトル。既に値が入っている場合は上書きしない */
  title: string;
  siteUrl: string | null;
}

/**
 * 本文を取得できた場合の更新。
 *
 * title / site_url は「まだ空のときだけ」入れる。M5 でユーザがリネームできるように
 * なるので、毎回フィード側の値で上書きすると手で付けた名前が消える。
 */
export async function markFetchSuccess(db: D1Database, p: FetchSuccessParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET etag = ?, last_modified = ?, content_hash = ?,
              next_fetch_at = ?, fetch_interval = ?,
              consecutive_failures = 0, last_error = NULL, last_fetched_at = ?,
              title = CASE WHEN title = '' THEN ? ELSE title END,
              site_url = COALESCE(site_url, ?)
        WHERE id = ?`,
    )
    .bind(
      p.etag,
      p.lastModified,
      p.contentHash,
      p.nextFetchAt,
      p.fetchInterval,
      p.now,
      p.title,
      p.siteUrl,
      p.id,
    )
    .run();
}

export interface FetchUnchangedParams {
  id: number;
  now: number;
  nextFetchAt: number;
  fetchInterval: number;
}

/** 304、または content_hash 一致でパースを省いた場合 */
export async function markFetchUnchanged(db: D1Database, p: FetchUnchangedParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET next_fetch_at = ?, fetch_interval = ?,
              consecutive_failures = 0, last_error = NULL, last_fetched_at = ?
        WHERE id = ?`,
    )
    .bind(p.nextFetchAt, p.fetchInterval, p.now, p.id)
    .run();
}

export interface FetchFailureParams {
  id: number;
  now: number;
  nextFetchAt: number;
  /** 今回の失敗を含めた連続失敗回数 */
  failures: number;
  message: string;
  disabled: boolean;
}

/** 取得・パースの失敗。握りつぶさず last_error に残して次回に活かす（CLAUDE.md） */
export async function markFetchFailure(db: D1Database, p: FetchFailureParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET next_fetch_at = ?, consecutive_failures = ?, last_error = ?,
              last_fetched_at = ?, disabled = ?
        WHERE id = ?`,
    )
    .bind(p.nextFetchAt, p.failures, p.message, p.now, p.disabled ? 1 : 0, p.id)
    .run();
}
