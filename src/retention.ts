import { RETENTION_DAYS } from '../shared/types';
import { deleteExpiredEntries } from './db/entries';

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

export interface RetentionOptions {
  now?: number;
  /** 保持期間（日）。テストから縮める */
  days?: number;
  /** 1 回の実行で消す上限。テストから縮める */
  maxPerRun?: number;
}

export interface RetentionSummary {
  deleted: number;
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

  let deleted = 0;
  while (deleted < maxPerRun) {
    const limit = Math.min(CHUNK, maxPerRun - deleted);
    const removed = await deleteExpiredEntries(env.DB, before, limit);
    deleted += removed;
    // 取れた件数が上限に届かなければ、対象は尽きている
    if (removed < limit) return { deleted, done: true };
  }
  return { deleted, done: false };
}
