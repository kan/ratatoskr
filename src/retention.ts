import { RETENTION_DAYS } from '../shared/types';
import { deleteExpiredEntries } from './db/entries';
import { deleteOldReadingEvents, refreshSkimmedFeeds } from './db/events';
import { deleteStaleRobots } from './db/robots';

/**
 * 保持期間による記事削除（docs/DESIGN.md §3「保持期間」）。
 *
 * D1 のサイズと未読数集計の速度を保つための後始末。既読・未ピンの記事だけが対象で、
 * 消える条件と残る条件は SQL 側（src/db/entries.ts）に書いてある。
 *
 * クロールとは別の cron で 1 日 1 回動かす（src/index.ts）。取得の 5 分毎の実行に
 * 混ぜないのは、毎回この掃除を挟むと、記事が入るまでの時間にただ積み上がるため。
 */

/**
 * 1 文で消す件数。D1 には長時間トランザクションが無いので細かく刻む
 * （CLAUDE.md「複数ステートメントは batch() にまとめる」の裏返しで、
 * 1 文が長くなりすぎる形も避ける）
 */
const CHUNK = 500;

/**
 * 1 回の実行で消す上限。
 *
 * 初回や、長く放置した後は数万件が対象になる。全部消し切ろうとして cron の実行時間を
 * 使い切るより、翌日に持ち越す方がよい（消し残しても読む分には何も困らない）。
 */
const MAX_PER_RUN = 10_000;

/** 読み方のデータを持つ日数（issue #43）。1 年ぶんあれば季節の偏りも見える */
const READING_EVENTS_DAYS = 365;

export interface RetentionOptions {
  now?: number;
  /** 保持期間（日）。テストから縮める */
  days?: number;
  /** 1 回の実行で消す上限。テストから縮める */
  maxPerRun?: number;
}

export interface RetentionSummary {
  deleted: number;
  /** 捨てた robots.txt の控えの数（issue #39） */
  robots: number;
  /** 対象を消し切ったか。false なら次回に持ち越している */
  done: boolean;
}

export async function purgeExpiredEntries(
  env: Env,
  options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const before = now - (options.days ?? RETENTION_DAYS) * 86_400;
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN;

  // robots.txt の控えは期限が切れても取り直しに失敗したときの拠り所になるので、
  // 記事と同じ保持期間だけ置いてから捨てる。購読を外したサイトの分が積み上がらないように
  // 読み方のデータ（issue #43）は記事より長く持つ（記事は消えても、どのフィードを
  // どう読んだかは残す価値がある）。印は直近の保持期間ぶんで付け直す。
  // 3 つは互いに依存しない（印は保持期間ぶんしか見ないので、1 年より古い行の掃除と競わない）
  const [robots] = await Promise.all([
    deleteStaleRobots(env.DB, before),
    deleteOldReadingEvents(env.DB, now - READING_EVENTS_DAYS * 86_400),
    refreshSkimmedFeeds(env.DB, before),
  ]);

  let deleted = 0;
  while (deleted < maxPerRun) {
    const limit = Math.min(CHUNK, maxPerRun - deleted);
    const removed = await deleteExpiredEntries(env.DB, before, limit, now);
    deleted += removed;
    // 取れた件数が上限に届かなければ、対象は尽きている
    if (removed < limit) return { deleted, robots, done: true };
  }
  return { deleted, robots, done: false };
}
