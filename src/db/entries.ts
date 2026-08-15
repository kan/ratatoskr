/**
 * entries に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 */

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
