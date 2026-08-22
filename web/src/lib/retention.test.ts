import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/types';
import { isPrunable, prunedAt, type PruneContext } from './retention';

const NOW = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
const DAY = 86_400;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 10,
    feedId: 1,
    url: 'https://example.com/entries/10',
    title: '記事',
    author: null,
    body: '',
    publishedAt: null,
    storedAt: NOW - 40 * DAY,
    ...overrides,
  };
}

function context(overrides: Partial<PruneContext> = {}): PruneContext {
  return {
    before: prunedAt(NOW),
    readSeq: 100,
    pinnedUrls: new Set<string>(),
    forcedUnread: new Set<number>(),
    ...overrides,
  };
}

describe('isPrunable', () => {
  it('既読・未ピン・保持期間を過ぎた記事は捨てる', () => {
    expect(isPrunable(entry(), context())).toBe(true);
  });

  it('保持期間の中の記事は残す', () => {
    expect(isPrunable(entry({ storedAt: NOW - 10 * DAY }), context())).toBe(false);
  });

  it('未読の記事は、どれだけ古くても残す', () => {
    // 後から古い日付で流れてきた記事は未読として残す（不変条件 1）
    expect(isPrunable(entry({ id: 200 }), context())).toBe(false);
  });

  it('u で未読に戻した記事は残す', () => {
    // 画面には未読として出ているので、実体だけ消えると読めない記事が並ぶ
    expect(isPrunable(entry({ id: 10 }), context({ forcedUnread: new Set([10]) }))).toBe(false);
  });

  it('ピンの立った記事は残す', () => {
    const pinned = new Set(['https://example.com/entries/10']);
    expect(isPrunable(entry(), context({ pinnedUrls: pinned }))).toBe(false);
  });

  it('url を持たない記事はピンの対象になり得ないので捨てられる', () => {
    expect(isPrunable(entry({ url: null }), context())).toBe(true);
  });
});

describe('prunedAt', () => {
  it('保持期間の分だけ遡った時刻を返す', () => {
    expect(prunedAt(NOW)).toBe(NOW - 30 * DAY);
  });
});
