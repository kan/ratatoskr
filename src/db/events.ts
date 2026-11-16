import type { ReadingEvent } from '../../shared/types';

/**
 * reading_events に対するクエリ（issue #43。migrations/0011_reading_events.sql）。
 */

/**
 * 読み方のデータを入れる。id が同じものは黙って捨てる（outbox の再送で冪等にするため）。
 *
 * 記事とフィードの中身はここで写す。端末から送らせないのは、送る量を減らすのと、
 * 端末の持っている古い見出しではなくサーバの値で揃えるため
 */
export async function insertReadingEvents(db: D1Database, events: ReadingEvent[]): Promise<void> {
  if (events.length === 0) return;
  const statement = db.prepare(
    `INSERT OR IGNORE INTO reading_events
       (id, kind, at, feed_id, entry_id, feed_title, entry_title, entry_url, target_url, seconds)
     SELECT ?1, ?2, ?3, ?4, ?5, f.title, e.title, e.url, ?6, ?7
       FROM (SELECT 1)
       LEFT JOIN feeds f ON f.id = ?4
       LEFT JOIN entries e ON e.id = ?5`,
  );
  await db.batch(
    events.map((event) =>
      statement.bind(
        event.id,
        event.kind,
        event.at,
        event.feedId,
        event.entryId,
        event.kind === 'link' ? event.url : null,
        event.kind === 'dwell' ? event.seconds : null,
      ),
    ),
  );
}

/** 「読んだ」と数える表示の秒数。これより短い表示は送っただけとみなす */
export const SKIM_SECONDS = 5;
/** 判定に使う表示の最小件数。少ない件数で決めつけない */
export const SKIM_MIN_VIEWS = 20;
/** これ以上の割合を送っただけなら、ほとんど読んでいないとみなす */
export const SKIM_RATIO = 0.9;

/**
 * ほとんど読まずに送っているフィードに印を付け直す（1 日 1 回。src/retention.ts）。
 *
 * 直近 `since` 以降に表示した記事のうち、表示時間の合計が SKIM_SECONDS 秒未満のものが
 * SKIM_RATIO 以上で、リンクも元記事も開いていないフィード。**ピンを立てた記事がある
 * フィードは外す**（ピンは「後で読む」なので、送っていても関心はある）。
 *
 * **記事ごとに合計してから数える。** 表示時間はタブを隠すたびに区切って積むので
 * （stores/reading.ts）、1 記事が複数の行になる。行のまま数えると、区切られた短い行が
 * 「送っただけ」に数えられる
 *
 * **印の変わるフィードだけを書く。** 毎日全てのフィードの行を書き直さない
 */
export async function refreshSkimmedFeeds(db: D1Database, since: number): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds SET skimmed = calc.value
         FROM (SELECT f.id, COALESCE((
                 SELECT CASE
                          WHEN COUNT(*) >= ?2
                           AND SUM(CASE WHEN viewed.seconds < ?3 THEN 1 ELSE 0 END) >= COUNT(*) * ?4
                           AND NOT EXISTS (
                                 SELECT 1 FROM reading_events o
                                  WHERE o.feed_id = f.id AND o.at >= ?1
                                    AND o.kind IN ('link', 'open'))
                           AND NOT EXISTS (
                                 SELECT 1 FROM pins p JOIN entries e ON e.id = p.entry_id
                                  WHERE e.feed_id = f.id)
                          THEN 1 ELSE 0 END
                   FROM (SELECT SUM(ev.seconds) AS seconds
                           FROM reading_events ev
                          WHERE ev.feed_id = f.id AND ev.kind = 'dwell' AND ev.at >= ?1
                          GROUP BY ev.entry_id) viewed), 0) AS value
                 FROM feeds f) AS calc
        WHERE calc.id = feeds.id AND feeds.skimmed <> calc.value`,
    )
    .bind(since, SKIM_MIN_VIEWS, SKIM_SECONDS, SKIM_RATIO)
    .run();
}

/** 保持期間を過ぎた読み方のデータを捨てる */
export async function deleteOldReadingEvents(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare('DELETE FROM reading_events WHERE at < ?').bind(before).run();
  return result.meta.changes;
}
