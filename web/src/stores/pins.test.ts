import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Pin } from '@shared/types';
import { usePinsStore } from './pins';

/**
 * ピンは記事より長生きし、既読とは独立している（docs/UX.md）。
 * ここで見るのは「送信が通る前後で一覧が崩れないこと」。
 */

function entry(id: number, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    feedId: 1,
    url: `https://example.com/${id}`,
    title: `記事 ${id}`,
    author: null,
    body: '',
    publishedAt: null,
    storedAt: 0,
    ...overrides,
  };
}

function pin(id: number, url: string): Pin {
  return { id, entryId: null, title: 'サーバのピン', url, pinnedAt: 100 };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('ピン', () => {
  it('押した瞬間に一覧へ出る（サーバの応答を待たない）', () => {
    const pins = usePinsStore();
    const added = pins.add(entry(10), 200);

    expect(added).not.toBeNull();
    expect(pins.count).toBe(1);
    expect(pins.has('https://example.com/10')).toBe(true);
    // まだサーバの id は無い。負の値で仮に置く
    expect(pins.pins[0].id).toBeLessThan(0);
  });

  it('同じ記事を二度ピンしても増えない', () => {
    const pins = usePinsStore();
    pins.add(entry(10), 200);
    expect(pins.add(entry(10), 300)).toBeNull();
    expect(pins.count).toBe(1);
  });

  it('URL の無い記事はピンできない（開く先が無い）', () => {
    const pins = usePinsStore();
    expect(pins.add(entry(10, { url: null }), 200)).toBeNull();
    expect(pins.count).toBe(0);
  });

  it('送信が通ったらサーバの id に差し替える', () => {
    const pins = usePinsStore();
    pins.add(entry(10), 200);
    pins.confirm('https://example.com/10', 42);

    expect(pins.find('https://example.com/10')?.id).toBe(42);
  });

  it('サーバの一覧で置き換えても、送信前のピンは消えない', () => {
    const pins = usePinsStore();
    pins.add(entry(10), 200); // まだ送信が通っていない
    pins.setPins([pin(1, 'https://example.com/other')]);

    expect(pins.pins.map((p) => p.url)).toEqual([
      'https://example.com/10',
      'https://example.com/other',
    ]);
  });

  it('サーバの一覧に同じ URL が来たら、そちらを正とする', () => {
    const pins = usePinsStore();
    pins.add(entry(10), 200);
    pins.setPins([pin(7, 'https://example.com/10')]);

    expect(pins.count).toBe(1);
    expect(pins.pins[0].id).toBe(7);
  });

  it('外すのは url で行う（仮 id は起動をまたぐと信用できない）', () => {
    const pins = usePinsStore();
    pins.setPins([pin(1, 'https://example.com/a'), pin(2, 'https://example.com/b')]);
    pins.remove('https://example.com/a');

    expect(pins.pins.map((p) => p.id)).toEqual([2]);
  });

  it('復元した未送信のピンと、仮 id が衝突しない', () => {
    const pins = usePinsStore();
    // 前回の起動で付けたまま送れていないピン（仮 id は負のまま保存されている）
    pins.setPins([
      { id: -1, entryId: 5, title: '前回のピン', url: 'https://example.com/5', pinnedAt: 1 },
    ]);
    pins.add(entry(10), 200);

    const ids = pins.pins.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // 片方を外しても、もう片方は残る
    pins.remove('https://example.com/10');
    expect(pins.pins.map((p) => p.url)).toEqual(['https://example.com/5']);
  });

  it('url は正規化して持つ（サーバの返す形に合わせる）', () => {
    const pins = usePinsStore();
    pins.add(entry(10, { url: 'https://example.com' }), 200);

    expect(pins.pins[0].url).toBe('https://example.com/');
    // 正規化前の URL で引いても見つかる
    expect(pins.has('https://example.com')).toBe(true);
  });
});
