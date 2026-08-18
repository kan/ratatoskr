import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
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

  /**
   * ウォーターマークから逸脱する記事（u で未読に戻したもの）。サーバの entry_states
   * の写しで、行があるのは例外だけ。既読フラグは持たない（不変条件 1）。
   */
  const forcedUnread = reactive(new Set<number>());

  /** 例外が動いたことだけを伝える。手元への書き戻しと outbox への積み増しがこれを見る */
  const unreadRevision = ref(0);

  /**
   * 未読かどうか。ウォーターマークによる判定に、例外の記事を足したもの。
   * 未読の抽出と未読数の集計で必ず同じ条件を使うため、判定はここ 1 箇所に置く。
   */
  function isUnread(entryId: number, readSeq: number): boolean {
    return forcedUnread.has(entryId) || !isRead(entryId, readSeq);
  }

  /**
   * 例外を足す / 外す。実際に変わったときだけ true を返す
   * （呼び出し側が未読数の数え直しと送信を必要なときだけ行えるように）。
   */
  function setForcedUnread(entryId: number, unread: boolean): boolean {
    if (forcedUnread.has(entryId) === unread) return false;
    if (unread) forcedUnread.add(entryId);
    else forcedUnread.delete(entryId);
    unreadRevision.value += 1;
    return true;
  }

  /**
   * そのフィードの例外をまとめて外す（Shift+S）。実際に外れたら true を返す。
   * 例外はほぼ常にゼロ件なので、その場合は記事の走査ごと省く。
   */
  function clearForcedUnreadIn(feedId: number): boolean {
    if (forcedUnread.size === 0) return false;
    let cleared = false;
    for (const entry of of(feedId)) {
      if (setForcedUnread(entry.id, false)) cleared = true;
    }
    return cleared;
  }

  /** 起動時に IndexedDB から読み戻す。保存済みなのでリビジョンは動かさない */
  function restoreForcedUnread(entryIds: number[]): void {
    for (const entryId of entryIds) forcedUnread.add(entryId);
  }

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
    return of(feedId).filter((entry) => isUnread(entry.id, readSeq));
  }

  /** 件数だけが要るとき用。未読の配列を作って捨てるのを避ける */
  function countUnread(feedId: number, readSeq: number): number {
    let count = 0;
    for (const entry of of(feedId)) {
      if (isUnread(entry.id, readSeq)) count += 1;
    }
    return count;
  }

  /** そのフィードについて手元にある最大 id。一括既読の到達点に使う */
  function maxIdOf(feedId: number): number {
    const list = of(feedId);
    return list.length === 0 ? 0 : list[list.length - 1].id;
  }

  return {
    byFeed,
    forcedUnread,
    unreadRevision,
    ingest,
    of,
    isUnread,
    setForcedUnread,
    clearForcedUnreadIn,
    restoreForcedUnread,
    unreadOf,
    countUnread,
    maxIdOf,
  };
});
