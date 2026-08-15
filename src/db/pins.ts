import type { Pin } from '../../shared/types';

/**
 * pins に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 * 追加・削除は M6 で足す。ここでは読み取りだけ。
 */

interface PinRow {
  id: number;
  entry_id: number | null;
  title: string;
  url: string;
  pinned_at: number;
}

function toPin(row: PinRow): Pin {
  return {
    id: row.id,
    entryId: row.entry_id,
    title: row.title,
    url: row.url,
    pinnedAt: row.pinned_at,
  };
}

/** 新しい順。ピンは記事より長生きするので、記事の有無に関わらず全件返す */
export async function selectPins(db: D1Database): Promise<Pin[]> {
  const { results } = await db
    .prepare(
      `SELECT id, entry_id, title, url, pinned_at
         FROM pins
        ORDER BY pinned_at DESC, id DESC`,
    )
    .all<PinRow>();
  return results.map(toPin);
}
