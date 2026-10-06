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
  nsfw: number;
}

function toPin(row: PinRow): Pin {
  return {
    id: row.id,
    entryId: row.entry_id,
    title: row.title,
    url: row.url,
    pinnedAt: row.pinned_at,
    nsfw: row.nsfw === 1,
  };
}

const PIN_COLUMNS = 'id, entry_id, title, url, pinned_at, nsfw';

/**
 * フィードの NSFW の印を、そのフィードの記事を指すピンへ写す文。フィードの印を
 * 変えたときに、設定の更新と同じ batch に混ぜて使う（src/db/feeds.ts の updateFeedSettings）。
 *
 * **記事が保持期間で消えたピンには届かない**（entry_id が NULL で、どのフィードの
 * 記事だったかを引けない）。そちらは立てた時点の印のまま残る。
 *
 * 束縛は (nsfw, feed_id) の順
 */
export const COPY_NSFW_TO_PINS = `UPDATE pins SET nsfw = ?
  WHERE entry_id IN (SELECT id FROM entries WHERE feed_id = ?)`;

/** 新しい順。ピンは記事より長生きするので、記事の有無に関わらず全件返す */
export async function selectPins(db: D1Database): Promise<Pin[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PIN_COLUMNS}
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
  /** クライアントが見た、記事のフィードの NSFW の印。記事から引けないときだけ使う */
  nsfw: boolean;
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
      // 存在確認を別の SELECT にすると、1 リクエストの往復が 1 つ増える。
      //
      // NSFW の印は記事のフィードから写す（記事が消えた後は引けなくなるため。
      // migrations/0006_nsfw.sql）。記事が既に無いときは、同じ url のピンが持っていた
      // 印と、クライアントが見た印のどちらかが立っていれば立てる。0 に倒すと、
      // 記事が消えた後の送り直しや、手元にしか残っていない記事のピンで、
      // 隠すはずのピンが表に出る
      `INSERT OR REPLACE INTO pins (entry_id, title, url, pinned_at, nsfw)
       VALUES (
         (SELECT id FROM entries WHERE id = ?1), ?2, ?3, ?4,
         COALESCE(
           (SELECT f.nsfw FROM entries e JOIN feeds f ON f.id = e.feed_id WHERE e.id = ?1),
           MAX(COALESCE((SELECT nsfw FROM pins WHERE url = ?3), 0), ?5)
         )
       )
       RETURNING ${PIN_COLUMNS}`,
    )
    .bind(pin.entryId, pin.title, pin.url, now, pin.nsfw ? 1 : 0)
    .first<PinRow>();

  if (row === null) throw new Error('ピンの追加に失敗');
  return toPin(row);
}

export async function deletePin(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM pins WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
