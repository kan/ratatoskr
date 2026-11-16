import type { RobotsState } from '../crawler/robots';

/**
 * robots_txt に対するクエリ（migrations/0008_robots_txt.sql）。
 */

export interface StoredRobots {
  state: RobotsState;
  body: string;
  expiresAt: number;
}

interface RobotsRow {
  state: string;
  body: string;
  expires_at: number;
}

function isRobotsState(value: string): value is RobotsState {
  return value === 'ok' || value === 'allow_all' || value === 'disallow_all';
}

/** 控えを引く。期限切れでも返す（取り直しに失敗したときの拠り所にする） */
export async function selectRobots(db: D1Database, origin: string): Promise<StoredRobots | null> {
  const row = await db
    .prepare('SELECT state, body, expires_at FROM robots_txt WHERE origin = ?')
    .bind(origin)
    .first<RobotsRow>();
  if (row === null || !isRobotsState(row.state)) return null;
  return { state: row.state, body: row.body, expiresAt: row.expires_at };
}

export async function upsertRobots(
  db: D1Database,
  origin: string,
  robots: StoredRobots,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO robots_txt (origin, state, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (origin) DO UPDATE
         SET state = excluded.state, body = excluded.body,
             fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    )
    .bind(origin, robots.state, robots.body, now, robots.expiresAt)
    .run();
}

/**
 * 長く使われていない控えを捨てる（保持期間の掃除と同じ cron。src/retention.ts）。
 *
 * 購読を外したサイトの控えが積み上がらないように。期限が切れていても取り直しに
 * 失敗したときの拠り所にはなるので、期限ではなく「期限から更に日が経ったもの」を捨てる
 */
export async function deleteStaleRobots(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare('DELETE FROM robots_txt WHERE expires_at < ?').bind(before).run();
  return result.meta.changes;
}
