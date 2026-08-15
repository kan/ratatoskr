/**
 * テスト用の足場。ここだけは src/db/ の外で SQL を書く。
 *
 * フィードの登録は M5（POST /api/feeds）の仕事なので、クエリ層には
 * まだ INSERT を置かない。テストが必要とする分だけをここに閉じ込める。
 */

export interface FeedSeed {
  url: string;
  title: string;
  siteUrl: string | null;
  rate: number;
  readSeq: number;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  nextFetchAt: number;
  fetchInterval: number;
  consecutiveFailures: number;
  disabled: number;
}

export interface FeedRow {
  id: number;
  url: string;
  title: string;
  site_url: string | null;
  read_seq: number;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  next_fetch_at: number;
  fetch_interval: number;
  consecutive_failures: number;
  last_error: string | null;
  last_fetched_at: number | null;
  disabled: number;
}

export interface EntryRow {
  id: number;
  feed_id: number;
  guid_hash: string;
  url: string | null;
  title: string;
  author: string | null;
  body: string;
  published_at: number | null;
  stored_at: number;
}

export async function seedFeed(
  db: D1Database,
  url: string,
  overrides: Partial<FeedSeed> = {},
): Promise<number> {
  const seed: FeedSeed = {
    url,
    title: '',
    siteUrl: null,
    rate: 3,
    readSeq: 0,
    etag: null,
    lastModified: null,
    contentHash: null,
    nextFetchAt: 0,
    fetchInterval: 900,
    consecutiveFailures: 0,
    disabled: 0,
    ...overrides,
  };

  const row = await db
    .prepare(
      `INSERT INTO feeds
         (url, title, site_url, rate, read_seq, etag, last_modified, content_hash,
          next_fetch_at, fetch_interval, consecutive_failures, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      seed.url,
      seed.title,
      seed.siteUrl,
      seed.rate,
      seed.readSeq,
      seed.etag,
      seed.lastModified,
      seed.contentHash,
      seed.nextFetchAt,
      seed.fetchInterval,
      seed.consecutiveFailures,
      seed.disabled,
      0,
    )
    .first<{ id: number }>();

  if (row === null) throw new Error('feed の投入に失敗');
  return row.id;
}

export async function getFeedRow(db: D1Database, id: number): Promise<FeedRow> {
  const row = await db.prepare('SELECT * FROM feeds WHERE id = ?').bind(id).first<FeedRow>();
  if (row === null) throw new Error(`feed ${id} が無い`);
  return row;
}

/** id 昇順。採番順＝読む順序なので、順序の検証もこれで行う */
export async function getEntryRows(db: D1Database, feedId: number): Promise<EntryRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM entries WHERE feed_id = ? ORDER BY id')
    .bind(feedId)
    .all<EntryRow>();
  return results;
}
