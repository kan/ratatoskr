import { defineStore } from 'pinia';
import { reactive } from 'vue';
import type { Entry } from '@shared/types';

/**
 * 既読判定。ウォーターマークより後ろ（id > read_seq）が未読で、記事ごとの既読フラグは
 * 持たない（CLAUDE.md の不変条件 1）。比較の向きを間違えないよう、判定はここだけに書く。
 */
export function isRead(entryId: number, readSeq: number): boolean {
  return entryId <= readSeq;
}

/**
 * 手元に持っている記事の置き場。
 *
 * 「どれを読んでいるか」はここでは持たない。カーソルはフィードリストが単独で
 * 所有する（CLAUDE.md の不変条件 2）。ここは純粋な記事の貯蔵庫。
 */
export const useEntriesStore = defineStore('entries', () => {
  // feed_id → 記事（id 昇順）。id の並びがそのまま読む順序
  const byFeed = reactive<Record<number, Entry[]>>({});

  /** 重複は id で吸収する。同じ記事が bootstrap と背景取得の両方から来る */
  function ingest(entries: Entry[]): void {
    if (entries.length === 0) return;

    const touched = new Set<number>();
    for (const entry of entries) {
      const list = (byFeed[entry.feedId] ??= []);
      list.push(entry);
      touched.add(entry.feedId);
    }
    for (const feedId of touched) {
      const unique = new Map(byFeed[feedId].map((entry) => [entry.id, entry]));
      byFeed[feedId] = [...unique.values()].sort((a, b) => a.id - b.id);
    }
  }

  function of(feedId: number): Entry[] {
    return byFeed[feedId] ?? [];
  }

  function unreadOf(feedId: number, readSeq: number): Entry[] {
    return of(feedId).filter((entry) => !isRead(entry.id, readSeq));
  }

  /** 件数だけが要るとき用。未読の配列を作って捨てるのを避ける */
  function countUnread(feedId: number, readSeq: number): number {
    let count = 0;
    for (const entry of of(feedId)) {
      if (!isRead(entry.id, readSeq)) count += 1;
    }
    return count;
  }

  /** そのフィードについて手元にある最大 id。一括既読の到達点に使う */
  function maxIdOf(feedId: number): number {
    const list = of(feedId);
    return list.length === 0 ? 0 : list[list.length - 1].id;
  }

  return { byFeed, ingest, of, unreadOf, countUnread, maxIdOf };
});
