import { describe, expect, it } from 'vitest';
import {
  backoffAfterFailure,
  intervalAfterNoUpdate,
  intervalAfterUpdate,
  INITIAL_INTERVAL,
  MAX_BACKOFF,
  MAX_INTERVAL,
  shouldDisable,
} from './schedule';

describe('取得間隔の適応制御', () => {
  it('更新があれば 1 時間に戻す', () => {
    expect(intervalAfterUpdate()).toBe(INITIAL_INTERVAL);
  });

  it('更新が無ければ 1.5 倍に伸ばす', () => {
    expect(intervalAfterNoUpdate(3600)).toBe(5400);
    expect(intervalAfterNoUpdate(5400)).toBe(8100);
  });

  it('6 時間で頭打ちにする', () => {
    let interval = INITIAL_INTERVAL;
    for (let i = 0; i < 50; i += 1) interval = intervalAfterNoUpdate(interval);
    expect(interval).toBe(MAX_INTERVAL);
  });

  it('上限を渡されたら、そこで頭打ちにする', () => {
    expect(intervalAfterNoUpdate(INITIAL_INTERVAL, INITIAL_INTERVAL)).toBe(INITIAL_INTERVAL);
    expect(intervalAfterNoUpdate(MAX_INTERVAL, 7200)).toBe(7200);
  });
});

describe('失敗バックオフ', () => {
  it('1 回目は取得間隔と同じ 1 時間、以降は倍々', () => {
    expect(backoffAfterFailure(1)).toBe(3600);
    expect(backoffAfterFailure(2)).toBe(7200);
    expect(backoffAfterFailure(3)).toBe(14400);
  });

  it('24 時間で頭打ちにする', () => {
    expect(backoffAfterFailure(20)).toBe(MAX_BACKOFF);
    expect(backoffAfterFailure(1000)).toBe(MAX_BACKOFF);
  });

  it('連続 20 回を超えたら無効化する', () => {
    expect(shouldDisable(20)).toBe(false);
    expect(shouldDisable(21)).toBe(true);
  });
});
