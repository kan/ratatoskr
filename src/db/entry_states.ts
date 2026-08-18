/**
 * entry_states に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 *
 * ウォーターマークから逸脱する記事だけを記録する例外テーブル。行があるのは
 * 「一度既読になったが手動で未読に戻した記事」のみで、全記事分の行は作らない
 * （docs/DESIGN.md §4）。未読判定での使われ方は db/unread.ts を参照。
 */

/** 記事の所属フィード。存在しない記事なら null（404 の判定に使う） */
export async function selectEntryFeedId(db: D1Database, entryId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT feed_id FROM entries WHERE id = ?')
    .bind(entryId)
    .first<{ feed_id: number }>();
  return row?.feed_id ?? null;
}

/**
 * 記事を未読に戻す。ウォーターマークは動かさない（docs/API.md）。
 * 動かすと、その記事以降の既読が全て巻き戻ってしまう。
 *
 * 同じ記事に対して何度呼んでも結果は変わらない（outbox の再送があるため冪等にする）。
 */
export async function insertEntryUnread(
  db: D1Database,
  entryId: number,
  now: number,
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO entry_states (entry_id, unread, updated_at) VALUES (?, 1, ?)')
    .bind(entryId, now)
    .run();
}

/**
 * 未読に戻した記事を既読に戻す。行を消すだけでよく、既読フラグは作らない。
 * 行が無ければウォーターマークによる判定に戻る。
 */
export async function deleteEntryUnread(db: D1Database, entryId: number): Promise<void> {
  await db.prepare('DELETE FROM entry_states WHERE entry_id = ?').bind(entryId).run();
}
