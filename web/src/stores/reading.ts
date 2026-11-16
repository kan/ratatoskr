import { defineStore } from 'pinia';
import { watch } from 'vue';
import type { Entry, ReadingEvent } from '@shared/types';
import { createDwellClock } from '@/lib/dwell';
import { httpHref } from '@/lib/url';
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

/** 積む中身の違う部分。id・時刻・記事は log が埋める */
type EventDetail =
  { kind: 'dwell'; seconds: number } | { kind: 'link'; url: string } | { kind: 'open' };

export const useReadingStore = defineStore('reading', () => {
  const feeds = useFeedsStore();
  const outbox = useOutboxStore();
  const clock = createDwellClock();
  let current: Entry | null = null;
  /** 最後に操作を数えた秒。スクロールは毎フレーム来るので、同じ秒の間は数え直さない */
  let lastActivity = 0;

  // 時刻は全て Unix 秒（CLAUDE.md）。時計にも同じ値を渡す
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  function log(entry: Entry, detail: EventDetail, at = nowSeconds()): void {
    const event = {
      id: crypto.randomUUID(),
      at,
      feedId: entry.feedId,
      entryId: entry.id,
      ...detail,
    } as ReadingEvent;
    outbox.queueEvent(event);
  }

  /**
   * いま表示している記事の分を締めて積む。**締めたら記事を手放す。** 隠れている間に
   * カーソルが動くと、もう一度締めに来る（同じ記事の分を二度積まない）
   */
  function close(at: number): void {
    if (current === null) return;
    const seconds = clock.stop(at);
    const closed = current;
    current = null;
    if (seconds >= MIN_SECONDS) log(closed, { kind: 'dwell', seconds }, at);
  }

  /**
   * 記事の表示を始める。**見えていなければ止まった状態で始める。** フォーカスの無い窓で
   * 記事が変わった（背景の同期がカーソルを座らせ直した）ときも、フォーカスが戻った時点から
   * 数えられるように
   */
  function open(entry: Entry | null, at: number): void {
    current = entry;
    if (entry === null) return;
    clock.start(at);
    if (!visible()) clock.pause(at);
  }

  function visible(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  /** 本文中のリンクを開いた */
  function logLink(url: string): void {
    const entry = feeds.currentEntry;
    const href = httpHref(url);
    if (entry !== null && href !== null) log(entry, { kind: 'link', url: href });
  }

  /** 元記事を開いた（v） */
  function logOpen(): void {
    const entry = feeds.currentEntry;
    if (entry !== null) log(entry, { kind: 'open' });
  }

  /** 何か操作した（キー・スクロール・タップ） */
  function activity(): void {
    const at = nowSeconds();
    if (at === lastActivity) return;
    lastActivity = at;
    clock.activity(at);
  }

  /**
   * 契機を張る。**outbox の install より前に呼ぶ。** 離脱時は「表示時間を締めて積む →
   * outbox が送る」の順でなければ、最後に読んでいた記事の分が送られない（stores/session.ts）
   */
  function install(): void {
    open(feeds.currentEntry, nowSeconds());
    watch(
      () => feeds.currentEntry,
      (entry, previous) => {
        if (entry?.id === previous?.id) return;
        const at = nowSeconds();
        close(at);
        open(entry, at);
      },
      // **次の記事を描いてから積む。** 記録は急がないので、記事送りの描画の前に割り込ませない
      { flush: 'post' },
    );
    document.addEventListener('visibilitychange', () => {
      const at = nowSeconds();
      if (document.visibilityState === 'hidden') {
        // 一度締める。隠れたまま閉じられても、そこまで読んだ分は残る
        close(at);
        return;
      }
      open(feeds.currentEntry, at);
    });
    window.addEventListener('blur', () => clock.pause(nowSeconds()));
    window.addEventListener('focus', () => clock.resume(nowSeconds()));
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
