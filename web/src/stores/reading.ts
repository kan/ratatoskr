import { defineStore } from 'pinia';
import { watch } from 'vue';
import type { Entry } from '@shared/types';
import { createDwellClock } from '@/lib/dwell';
import { useFeedsStore } from './feeds';
import { useOutboxStore } from './outbox';

/**
 * 読み方のデータを記録する（issue #43）。
 *
 * - **表示時間**は、カーソルが記事を移ったとき（stores/feeds.ts の currentEntry の変化）に
 *   区切って積む。タブが隠れたときも一度区切る（そのまま閉じられても、そこまでの分は残る）
 * - **リンク**と**元記事**は、開いたその場で積む
 *
 * 書き込みは全て outbox を通す（不変条件 3）。UI は送信を待たず、記事送りの経路では
 * 時刻を読んで足すことしかしない（docs/DESIGN.md の「唯一の目標」に響かせない）。
 * カーソルは読むだけで動かさない（不変条件 2）。
 */

/** これより短い表示は積まない。j を連打して素通りした記事でデータを埋めないため */
const MIN_SECONDS = 1;

export const useReadingStore = defineStore('reading', () => {
  const feeds = useFeedsStore();
  const outbox = useOutboxStore();
  const clock = createDwellClock();
  let current: Entry | null = null;

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  function newId(): string {
    return crypto.randomUUID();
  }

  /** いま表示している記事の分を締めて積む */
  function close(at: number): void {
    if (current === null) return;
    const seconds = clock.stop(at);
    if (seconds >= MIN_SECONDS) {
      outbox.queueEvent({
        id: newId(),
        kind: 'dwell',
        at: nowSeconds(),
        feedId: current.feedId,
        entryId: current.id,
        seconds,
      });
    }
  }

  function open(entry: Entry | null, at: number): void {
    current = entry;
    if (entry !== null && visible()) clock.start(at);
  }

  function visible(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  /** 本文中のリンクを開いた */
  function logLink(url: string): void {
    const entry = feeds.currentEntry;
    if (entry === null || !/^https?:\/\//i.test(url)) return;
    outbox.queueEvent({
      id: newId(),
      kind: 'link',
      at: nowSeconds(),
      feedId: entry.feedId,
      entryId: entry.id,
      url,
    });
  }

  /** 元記事を開いた（v） */
  function logOpen(): void {
    const entry = feeds.currentEntry;
    if (entry === null) return;
    outbox.queueEvent({
      id: newId(),
      kind: 'open',
      at: nowSeconds(),
      feedId: entry.feedId,
      entryId: entry.id,
    });
  }

  /** 何か操作した（キー・スクロール・タップ） */
  function activity(): void {
    clock.activity(Date.now());
  }

  /**
   * 契機を張る。**outbox の install より前に呼ぶ。** 離脱時は「表示時間を締めて積む →
   * outbox が送る」の順でなければ、最後に読んでいた記事の分が送られない（stores/session.ts）
   */
  function install(): void {
    open(feeds.currentEntry, Date.now());
    watch(
      () => feeds.currentEntry,
      (entry, previous) => {
        if (entry?.id === previous?.id) return;
        const at = Date.now();
        close(at);
        open(entry, at);
      },
    );
    document.addEventListener('visibilitychange', () => {
      const at = Date.now();
      if (document.visibilityState === 'hidden') {
        // 一度締める。隠れたまま閉じられても、そこまで読んだ分は残る
        close(at);
        return;
      }
      open(feeds.currentEntry, at);
    });
    window.addEventListener('blur', () => clock.pause(Date.now()));
    window.addEventListener('focus', () => clock.resume(Date.now()));
    // 読んでいる最中の操作。キーは App.vue の keydown が activity を呼ぶ（キーの判定は
    // keymap.ts に寄せてあり、ここで keydown を別に聞かない）
    for (const type of ['pointerdown', 'wheel', 'touchmove'] as const) {
      window.addEventListener(type, activity, { passive: true });
    }
    // 本文の入れ物はウィンドウではなく要素がスクロールするので、捕捉で拾う
    window.addEventListener('scroll', activity, { passive: true, capture: true });
  }

  return { install, activity, logLink, logOpen };
});
