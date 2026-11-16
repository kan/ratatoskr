import { describe, expect, it } from 'vitest';
import { createDwellClock, IDLE_LIMIT } from './dwell';

/** 時刻は Unix 秒で渡す */
describe('createDwellClock', () => {
  it('表示していた時間を秒で返す', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.activity(10);
    expect(clock.stop(25)).toBe(25);
  });

  it('操作の無い時間は 60 秒で頭打ちにする（開いたまま席を立った）', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.activity(5);
    expect(clock.stop(5 + 10 * 60)).toBe(5 + IDLE_LIMIT);
  });

  it('見えていない間は数えない', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.pause(10);
    clock.resume(100);
    expect(clock.stop(110)).toBe(20);
  });

  it('止めた後の操作は数えない。次の記事は 0 から', () => {
    const clock = createDwellClock();
    clock.start(0);
    expect(clock.stop(3)).toBe(3);
    clock.activity(50);
    clock.start(60);
    expect(clock.stop(61)).toBe(1);
  });

  it('続けて止めても、数えた分を二度返さない', () => {
    const clock = createDwellClock();
    clock.start(0);
    expect(clock.stop(30)).toBe(30);
    expect(clock.stop(40)).toBe(0);
  });

  it('止まった状態で始めれば、再開するまで数えない（フォーカスの無い窓で記事が変わった）', () => {
    const clock = createDwellClock();
    clock.start(0);
    clock.pause(0);
    clock.activity(20);
    clock.resume(50);
    expect(clock.stop(55)).toBe(5);
  });
});
