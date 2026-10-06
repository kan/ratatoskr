import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Pin } from '@shared/types';
import { useNsfwStore } from './nsfw';
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

function pin(id: number, url: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id,
    entryId: null,
    title: 'サーバのピン',
    url,
    pinnedAt: 100,
    nsfw: false,
    ...overrides,
  };
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
    pins.confirm('https://example.com/10', pin(42, 'https://example.com/10'));

    expect(pins.find('https://example.com/10')?.id).toBe(42);
  });

  it('タイトルの無い記事は、サーバが作った見出しを受け直す', () => {
    // 空のまま置くと、次の bootstrap まで一覧に URL が並ぶ（issue #11）
    const pins = usePinsStore();
    pins.add(entry(10, { title: '' }), 200);
    pins.confirm(
      'https://example.com/10',
      pin(42, 'https://example.com/10', { entryId: 10, title: '本文の書き出し' }),
    );

    expect(pins.find('https://example.com/10')?.title).toBe('本文の書き出し');
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
    pins.setPins([pin(-1, 'https://example.com/5', { entryId: 5, title: '前回のピン' })]);
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

describe('NSFW のピンを隠す（issue #23）', () => {
  it('既定では一覧にも件数にも出さないが、重複の判定には残す', () => {
    const pins = usePinsStore();
    pins.setPins([
      pin(1, 'https://example.com/hidden', { nsfw: true }),
      pin(2, 'https://example.com/shown'),
    ]);

    expect(pins.shown.map((p) => p.url)).toEqual(['https://example.com/shown']);
    expect(pins.count).toBe(1);
    expect([...pins.shownUrls]).toEqual(['https://example.com/shown']);
    // 手元の記事の間引きは、隠しているピンの記事も残す
    expect(pins.urls.has('https://example.com/hidden')).toBe(true);

    useNsfwStore().setVisible(true);
    expect(pins.count).toBe(2);
  });

  it('隠しているピンと同じ URL の記事では、外さずに立て直す', () => {
    // 同じ URL を NSFW のフィードと普通のフィードの両方が配っている場合
    const pins = usePinsStore();
    pins.setPins([pin(1, 'https://example.com/10', { nsfw: true })]);

    // 画面からは立っていないように見える。外す対象にもならない
    expect(pins.has('https://example.com/10')).toBe(false);
    expect(pins.findShown('https://example.com/10')).toBeUndefined();

    const added = pins.add(entry(10), 200, false);
    expect(added?.nsfw).toBe(false);
    // 二重には持たない
    expect(pins.pins).toHaveLength(1);
    expect(pins.count).toBe(1);
  });

  it('NSFW のフィードで立てたピンは、送信が通る前から隠れる', () => {
    useNsfwStore().setVisible(true);
    const pins = usePinsStore();
    pins.add(entry(10), 200, true);
    expect(pins.count).toBe(1);

    useNsfwStore().setVisible(false);
    expect(pins.count).toBe(0);
  });

  it('フィードの印を変えたら、その記事に立てたピンにも当てる', () => {
    const pins = usePinsStore();
    pins.setPins([
      pin(1, 'https://example.com/10', { entryId: 10 }),
      pin(2, 'https://example.com/20', { entryId: 20 }),
      // 記事が消えたピンは、どのフィードのものだったか分からないので動かさない
      pin(3, 'https://example.com/gone'),
    ]);
    const before = pins.revision;

    pins.setNsfwByEntries(new Set([10]), true);

    expect(pins.shown.map((p) => p.id)).toEqual([2, 3]);
    // 手元への書き戻しが走るように、変わったことを伝える
    expect(pins.revision).toBeGreaterThan(before);
  });
});
