import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Feed, Pin } from '@shared/types';
import { NSFW_KEY, readPref, writePref } from '@/lib/prefs';

/**
 * この端末で NSFW のフィードを出すか（issue #23。設計は docs/DESIGN.md §6）。
 *
 * **端末ごとの設定で、サーバには送らない。** 印（Feed.nsfw / Pin.nsfw）は全ての端末に
 * 同じものが届き、出すかどうかをここが決める。職場の PC では隠し、手元のスマホでは
 * 出す、という使い分けなので、同期してしまうと意味が無い。
 *
 * **既定は隠す。** 覚えていない端末（初めて開いた、保存を消した）で出てしまう方が
 * 困るので、出すと決めた端末だけが値を持つ。
 *
 * フィードとピンの両方のストアが同じものを見るので、どちらかの持ち物にしない。
 * テーマ（lib/theme.ts）のようにモジュールに置かないのは、フィードのストアがこれを
 * 監視してカーソルを動かすため。ストアの外に置くと、テストで捨てたストアの監視が
 * 生き残って次のテストに手を出す。
 */
export const useNsfwStore = defineStore('nsfw', () => {
  const visible = ref(readPref(NSFW_KEY) === '1');

  function setVisible(value: boolean): void {
    visible.value = value;
    writePref(NSFW_KEY, value ? '1' : null);
  }

  /** この端末で隠すものか。フィードとピンで同じ判定を使う */
  function isHidden(item: Pick<Feed | Pin, 'nsfw'>): boolean {
    return item.nsfw && !visible.value;
  }

  /**
   * 隠すものを除いた一覧。**隠すものが無ければ、渡された配列をそのまま返す。**
   * filter は毎回新しい配列を作るので、常態（隠すものが無い）でまで写しを作ると、
   * それを見ている側が中身の変わらない一覧を描き直す
   */
  function shownOf<T extends Pick<Feed | Pin, 'nsfw'>>(items: T[]): T[] {
    return items.some(isHidden) ? items.filter((item) => !isHidden(item)) : items;
  }

  return { visible, setVisible, isHidden, shownOf };
});
