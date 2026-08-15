import type { Entry } from '../../shared/types';
import { UNREAD_JOIN, UNREAD_PREDICATE } from './unread';

/**
 * entries に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 */

interface EntryRow {
  id: number;
  feed_id: number;
  url: string | null;
  title: string;
  author: string | null;
  body: string;
  published_at: number | null;
  stored_at: number;
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    feedId: row.feed_id,
    url: row.url,
    title: row.title,
    author: row.author,
    body: row.body,
    publishedAt: row.published_at,
    storedAt: row.stored_at,
  };
}

const ENTRY_COLUMNS = `e.id, e.feed_id, e.url, e.title, e.author, e.body,
         e.published_at, e.stored_at`;

export interface EntryQuery {
  /** この id より大きい記事を返す。ページングは必ずこれで行う（オフセットは使わない） */
  sinceId: number;
  feedId: number | null;
  unreadOnly: boolean;
  limit: number;
}

/** id 昇順。採番順がそのまま読む順序なので、並べ替えの余地は無い */
export async function selectEntries(db: D1Database, query: EntryQuery): Promise<Entry[]> {
  const conditions = ['e.id > ?'];
  const params: (number | string)[] = [query.sinceId];

  if (query.feedId !== null) {
    conditions.push('e.feed_id = ?');
    params.push(query.feedId);
  }
  if (query.unreadOnly) {
    conditions.push(UNREAD_PREDICATE);
  }
  params.push(query.limit);

  const { results } = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM entries e
         JOIN feeds f ON f.id = e.feed_id
         ${UNREAD_JOIN}
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.id
        LIMIT ?`,
    )
    .bind(...params)
    .all<EntryRow>();
  return results.map(toEntry);
}

/**
 * 指定したフィードの未読記事を、フィードごとに件数を区切って返す。
 * bootstrap が上位レートのフィードの本文を同梱するために使う。
 */
export async function selectUnreadEntriesByFeed(
  db: D1Database,
  feedIds: number[],
  perFeed: number,
): Promise<Entry[]> {
  if (feedIds.length === 0 || perFeed <= 0) return [];

  // フィードごとに LIMIT を効かせたいので 1 フィード 1 文にし、batch で 1 往復にまとめる
  const statement = db.prepare(
    `SELECT ${ENTRY_COLUMNS}
       FROM entries e
       JOIN feeds f ON f.id = e.feed_id
       ${UNREAD_JOIN}
      WHERE e.feed_id = ? AND ${UNREAD_PREDICATE}
      ORDER BY e.id
      LIMIT ?`,
  );
  const results = await db.batch<EntryRow>(feedIds.map((id) => statement.bind(id, perFeed)));
  return results.flatMap((result) => result.results.map(toEntry));
}

/** この時点でサーバが持つ最大 id。クライアントの差分取得のカーソルになる */
export async function selectMaxEntryId(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM entries')
    .first<{ max_id: number }>();
  return row?.max_id ?? 0;
}

export interface NewEntry {
  feedId: number;
  /** guid / link / (title + published) の優先順で選んだ値の SHA-256 */
  guidHash: string;
  url: string | null;
  title: string;
  author: string | null;
  /** サニタイズ済み HTML のみ */
  body: string;
  publishedAt: number | null;
}

// D1 の 1 バッチが際限なく膨らまないように区切る。フィード 1 本あたりの
// 記事数はたかが知れているので、この程度で十分
const BATCH_SIZE = 50;

/**
 * 記事を追加する。既に取り込み済みのものは (feed_id, guid_hash) の UNIQUE 制約に
 * 当たって黙って捨てられる。
 *
 * **配列の順序がそのまま id の採番順になる。** id は読む順序と未読判定の両方を
 * 担うので、呼び出し側は古い記事から順に並べて渡すこと（CLAUDE.md の不変条件 1）。
 *
 * @returns 実際に挿入された件数
 */
export async function insertEntries(
  db: D1Database,
  entries: NewEntry[],
  storedAt: number,
): Promise<number> {
  if (entries.length === 0) return 0;

  const statement = db.prepare(
    `INSERT OR IGNORE INTO entries
       (feed_id, guid_hash, url, title, author, body, published_at, stored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    // D1 には長時間トランザクションが無いので batch() にまとめる（CLAUDE.md）
    const results = await db.batch(
      entries
        .slice(i, i + BATCH_SIZE)
        .map((e) =>
          statement.bind(
            e.feedId,
            e.guidHash,
            e.url,
            e.title,
            e.author,
            e.body,
            e.publishedAt,
            storedAt,
          ),
        ),
    );
    for (const result of results) inserted += result.meta.changes ?? 0;
  }
  return inserted;
}
