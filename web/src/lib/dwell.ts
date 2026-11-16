/**
 * 記事を実際に読んでいた時間を測る時計（issue #43）。時刻を受け取るだけの純粋な計算で、
 * イベントの購読やタイマーは持たない（呼ぶ側は stores/reading.ts）。
 *
 * 数えるのは「画面が見えていてフォーカスがあり、最後の操作から IDLE_LIMIT 以内」の時間。
 * 開いたまま席を立った時間や、別のタブを見ていた時間を読んだことにしない。
 *
 * タイマーで毎秒数えない。操作のたびに「前の操作からの経過」を IDLE_LIMIT で頭打ちにして
 * 足せば同じ値になり、記事送りの経路に定期処理を挟まずに済む。
 */

/**
 * 操作が無いまま、読んでいると数え続ける上限（秒）。
 *
 * 時刻は全て Unix 秒（整数）で受ける（CLAUDE.md）。1 秒未満の端数は落ちるが、
 * 1 秒未満の表示はもともと数えない（stores/reading.ts の MIN_SECONDS）
 */
export const IDLE_LIMIT = 60;

export interface DwellClock {
  /** 記事の表示を始めた */
  start(now: number): void;
  /** 何か操作した（キー・スクロール・タップ） */
  activity(now: number): void;
  /** 見えなくなった・フォーカスを失った */
  pause(now: number): void;
  /** 見えるようになった・フォーカスを得た */
  resume(now: number): void;
  /** 表示を終えた。数えた秒数を返して止まり、数えた分を捨てる（二度返さない） */
  stop(now: number): number;
}

export function createDwellClock(): DwellClock {
  let total = 0;
  /** 最後に数えた時刻。null は数えていない（止まっている・見えていない） */
  let last: number | null = null;
  let running = false;

  const accrue = (now: number): void => {
    if (last === null) return;
    total += Math.max(0, Math.min(now - last, IDLE_LIMIT));
    last = now;
  };

  return {
    start(now) {
      total = 0;
      running = true;
      last = now;
    },
    // 止まっている間（last が null）の操作では再開しない。再開はフォーカスと可視性
    // （resume）が決める。ここで再開すると、見えていない窓へのホイールやタッチで数え始める
    activity(now) {
      accrue(now);
    },
    pause(now) {
      accrue(now);
      last = null;
    },
    resume(now) {
      if (running && last === null) last = now;
    },
    stop(now) {
      accrue(now);
      running = false;
      last = null;
      const seconds = total;
      total = 0;
      return seconds;
    },
  };
}
