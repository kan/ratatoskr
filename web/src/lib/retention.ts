import { RETENTION_DAYS, type Entry } from '@shared/types';

/**
 * 手元（IndexedDB）に置いた記事の間引き（M9）。
 *
 * **サーバ側（src/retention.ts）と同じ規則で捨てる。** 向こうが消した記事は
 * `GET /api/sync` にも `GET /api/entries` にも出てこない（削除は差分に載らない）ので、
 * こちらで捨てなければ、同期した記事が端末に永久に積み上がる。
 * 手元だけ長く持っても、サーバに無い記事は次の起動で復元できないので意味も無い。
 *
 * 判定だけをここに置く。実際に消すのは lib/db.ts、いつ回すかは stores/session.ts。
 */

export interface PruneContext {
  /** stored_at がこの時刻より前のものが対象 */
  before: number;
  /** そのフィードの既読ウォーターマーク */
  readSeq: number;
  /** ピンの立っている記事の url。ピンは記事より長く生きる（docs/DESIGN.md §3） */
  pinnedUrls: ReadonlySet<string>;
  /** u で未読に戻した記事。画面には未読として出ているので消せない */
  forcedUnread: ReadonlySet<number>;
}

export function prunedAt(now: number): number {
  return now - RETENTION_DAYS * 86_400;
}

/** 手元から捨ててよい記事か。1 つでも欠ければ残す */
export function isPrunable(entry: Entry, context: PruneContext): boolean {
  if (entry.storedAt >= context.before) return false;
  // 未読（ウォーターマークの先、または戻した例外）
  if (entry.id > context.readSeq || context.forcedUnread.has(entry.id)) return false;
  return entry.url === null || !context.pinnedUrls.has(entry.url);
}
