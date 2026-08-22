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

// 全文が取れていればそちらを body として返す。フィードが配信した本文（e.body）は
// 残したままにしてあるので、クライアントからはどちらが入っているか見えない（M7）。
// full_body の '' は「取りに行ったが採らなかった」印なので、本文としては使わない
const ENTRY_COLUMNS = `e.id, e.feed_id, e.url, e.title, e.author,
         COALESCE(NULLIF(e.full_body, ''), e.body) AS body,
         e.published_at, e.stored_at`;

/**
 * 保持期間を過ぎた記事を消す（docs/DESIGN.md §3「保持期間」）。
 *
 * 消すのは「既読で、ピンが付いておらず、取り込みから一定期間が過ぎたもの」だけ。
 *
 * - 既読の判定は未読判定の裏返しをそのまま使う（src/db/unread.ts）。手で未読に戻した
 *   記事（entry_states）は未読なので残る。ここで独自の条件を書くと、画面には未読として
 *   出ているのに実体が消えている状態になる
 * - ピンは記事より長く生きる（docs/DESIGN.md §3）。ピンの付いた記事は期間に関わらず残す。
 *   ピンそのものは title / url を持っているので、記事が消えても壊れない
 * - entry_states は ON DELETE CASCADE、pins.entry_id は ON DELETE SET NULL で追随する
 *
 * **一度に消す件数を必ず区切る。** D1 には長時間トランザクションが無く、初回は数万行が
 * 対象になり得るため（呼び出し側が刻んで回す。src/retention.ts）。
 *
 * @param before stored_at がこの時刻より前のものを対象にする
 * @returns 実際に消した件数
 */
export async function deleteExpiredEntries(
  db: D1Database,
  before: number,
  limit: number,
): Promise<number> {
  const { meta } = await db
    .prepare(
      `DELETE FROM entries
        WHERE id IN (
          SELECT e.id
            FROM entries e
            JOIN feeds f ON f.id = e.feed_id
            ${UNREAD_JOIN}
           WHERE e.stored_at < ?
             AND NOT (${UNREAD_PREDICATE})
             AND NOT EXISTS (SELECT 1 FROM pins p WHERE p.entry_id = e.id)
           ORDER BY e.id
           LIMIT ?)`,
    )
    .bind(before, limit)
    .run();
  return meta.changes ?? 0;
}

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

/** 記事ページから取ってくる対象。全文がまだ入っていない記事 */
export interface FullTextTarget {
  id: number;
  url: string;
  /** フィードが配信した本文。取れた全文がこれより短ければ抽出を疑う */
  bodyLength: number;
}

/**
 * 全文をまだ取りに行っていない未読記事を、**読む順（id 昇順）**に返す。
 *
 * 未読に絞るのは、読まないと決めた記事のために相手のサーバへ取りに行かないため。
 * 読む順なのは、上限で打ち切られたときに埋まるのが「これから最初に読む分」に
 * なるようにするため。新しい順にすると、未読 30 件のフィードで最初に埋まるのが
 * 最後に読む 10 件になり、設定を入れた直後の見え方がちょうど逆になる。
 *
 * full_body が '' の記事は「取りに行ったが採らなかった」ので二度と拾わない
 * （migrations/0003_full_text.sql）。
 */
export async function selectMissingFullText(
  db: D1Database,
  feedId: number,
  limit: number,
): Promise<FullTextTarget[]> {
  if (limit <= 0) return [];

  const { results } = await db
    .prepare(
      `SELECT e.id, e.url, LENGTH(e.body) AS body_length
         FROM entries e
         JOIN feeds f ON f.id = e.feed_id
         ${UNREAD_JOIN}
        WHERE e.feed_id = ? AND e.full_body IS NULL AND e.url IS NOT NULL
          AND ${UNREAD_PREDICATE}
        ORDER BY e.id
        LIMIT ?`,
    )
    .bind(feedId, limit)
    .all<{ id: number; url: string; body_length: number }>();

  return results.map((row) => ({ id: row.id, url: row.url, bodyLength: row.body_length }));
}

/**
 * 取れた全文を書き込む。body は触らない（元の要約を残す。migrations/0003 参照）。
 * fullBody に '' を渡すと「取りに行ったが採らなかった」印になり、次から拾われない。
 */
export async function updateFullBodies(
  db: D1Database,
  bodies: { id: number; fullBody: string }[],
): Promise<void> {
  if (bodies.length === 0) return;

  const statement = db.prepare('UPDATE entries SET full_body = ? WHERE id = ?');
  for (let i = 0; i < bodies.length; i += BATCH_SIZE) {
    await db.batch(
      bodies.slice(i, i + BATCH_SIZE).map((body) => statement.bind(body.fullBody, body.id)),
    );
  }
}

/** 手動更新（POST /api/feeds/:id/fetch）が、全文を埋めた記事を返すために使う */
export async function selectEntriesByIds(db: D1Database, ids: number[]): Promise<Entry[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM entries e
        WHERE e.id IN (${placeholders})
        ORDER BY e.id`,
    )
    .bind(...ids)
    .all<EntryRow>();
  return results.map(toEntry);
}

/**
 * 「取りに行ったが採らなかった」印を消して、もう一度試させる。
 *
 * 本文の位置を判定し直したとき（サイトの作り替え）に呼ぶ。前のセレクタで採れなかった
 * 記事は、新しいセレクタなら採れるかもしれない。取れている本文（'' でないもの）は残す。
 */
export async function clearRejectedFullText(db: D1Database, feedId: number): Promise<void> {
  await db
    .prepare(`UPDATE entries SET full_body = NULL WHERE feed_id = ? AND full_body = ''`)
    .bind(feedId)
    .run();
}

/**
 * そのフィードの全文を全て捨てる文。全文取得を切ったときに、設定の更新と同じ
 * batch に混ぜて使う（src/db/feeds.ts の updateFeedSettings）。
 *
 * 捨てないと、抽出が本文でないものを掴んでいた場合に元へ戻す手段が無くなる
 * （読み出しは COALESCE なので、設定を切っただけでは差し替わったままになる）。
 */
export const CLEAR_FULL_BODIES = 'UPDATE entries SET full_body = NULL WHERE feed_id = ?';

/**
 * 既に取り込み済みの guid_hash を返す。
 *
 * 取り込みは INSERT OR IGNORE なので、重複を避けるためだけならこれは要らない。
 * 要るのは**新しい記事にだけ外部への問い合わせをしたい**ため（埋め込みの解決。
 * src/crawler/embed.ts）。フィードは毎回全件を配るので、これが無いと更新のたびに
 * 既知の記事のぶんまで X へ問い合わせることになる。
 */
export async function selectKnownGuidHashes(
  db: D1Database,
  feedId: number,
  guidHashes: string[],
): Promise<Set<string>> {
  if (guidHashes.length === 0) return new Set();

  const known = new Set<string>();
  for (let i = 0; i < guidHashes.length; i += BATCH_SIZE) {
    const chunk = guidHashes.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT guid_hash FROM entries
          WHERE feed_id = ? AND guid_hash IN (${placeholders})`,
      )
      .bind(feedId, ...chunk)
      .all<{ guid_hash: string }>();
    for (const row of results) known.add(row.guid_hash);
  }
  return known;
}
