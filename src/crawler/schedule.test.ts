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
  it('更新があれば 15 分に戻す', () => {
    expect(intervalAfterUpdate()).toBe(INITIAL_INTERVAL);
  });

  it('更新が無ければ 1.5 倍に伸ばす', () => {
    expect(intervalAfterNoUpdate(900)).toBe(1350);
    expect(intervalAfterNoUpdate(1350)).toBe(2025);
  });

  it('6 時間で頭打ちにする', () => {
    let interval = INITIAL_INTERVAL;
    for (let i = 0; i < 50; i += 1) interval = intervalAfterNoUpdate(interval);
    expect(interval).toBe(MAX_INTERVAL);
  });
});

describe('失敗バックオフ', () => {
  it('1 回目は 15 分、以降は倍々', () => {
    expect(backoffAfterFailure(1)).toBe(900);
    expect(backoffAfterFailure(2)).toBe(1800);
    expect(backoffAfterFailure(3)).toBe(3600);
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
