import { describe, expect, it } from 'vitest';
import { createDwellClock, IDLE_LIMIT } from './dwell';

describe('createDwellClock', () => {
  it('表示していた時間を秒で返す', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.activity(10_000);
    expect(clock.stop(25_000)).toBe(25);
  });

  it('操作の無い時間は 60 秒で頭打ちにする（開いたまま席を立った）', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.activity(5_000);
    expect(clock.stop(5_000 + 10 * 60_000)).toBe(5 + IDLE_LIMIT / 1000);
  });

  it('見えていない間は数えない', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.pause(10_000);
    clock.resume(100_000);
    expect(clock.stop(110_000)).toBe(20);
  });

  it('止めた後の操作は数えない。次の記事は 0 から', () => {
    const clock = createDwellClock();
    clock.start(0);
    expect(clock.stop(3_000)).toBe(3);
    clock.activity(50_000);
    clock.start(60_000);
    expect(clock.stop(61_000)).toBe(1);
  });
});
