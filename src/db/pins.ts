import type { Pin } from '../../shared/types';

/**
 * pins に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
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

export interface NewPin {
  /** 記事が保持期間を過ぎて消えたら NULL になる。ピン自体は残る */
  entryId: number | null;
  title: string;
  url: string;
}

/**
 * ピンを追加する。
 *
 * url は UNIQUE。同じ記事を二度ピンしても増えないよう INSERT OR REPLACE で吸収する
 * （outbox からの再送があるので冪等でなければならない。docs/API.md）。
 * 置き換えになると id は振り直される。クライアントは応答の id を正とする。
 */
export async function insertPin(db: D1Database, pin: NewPin, now: number): Promise<Pin> {
  const row = await db
    .prepare(
      // entry_id は副問い合わせで引く。記事が既に消えていれば NULL になり、
      // 外部キー違反にならない（ピンは記事より長生きする）。
      // 存在確認を別の SELECT にすると、1 リクエストの往復が 1 つ増える
      `INSERT OR REPLACE INTO pins (entry_id, title, url, pinned_at)
       VALUES ((SELECT id FROM entries WHERE id = ?), ?, ?, ?)
       RETURNING id, entry_id, title, url, pinned_at`,
    )
    .bind(pin.entryId, pin.title, pin.url, now)
    .first<PinRow>();

  if (row === null) throw new Error('ピンの追加に失敗');
  return toPin(row);
}

export async function deletePin(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM pins WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
