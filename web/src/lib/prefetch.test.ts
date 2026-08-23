import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/types';
import { createImagePrefetcher, extractImageUrls, imageUrlsOf } from './prefetch';

/** 取りに行った URL を記録するだけの fetch。応答の中身は使わない */
function recordingFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { impl, calls };
}

/** Cache API のうち、先読みが使う put / delete だけを持つ最小の代役 */
function fakeCache(): { cache: Cache; stored: Set<string>; deleted: string[] } {
  const stored = new Set<string>();
  const deleted: string[] = [];
  const cache = {
    put(request: RequestInfo | URL) {
      stored.add(String(request));
      return Promise.resolve();
    },
    delete(request: RequestInfo | URL) {
      const url = String(request);
      deleted.push(url);
      return Promise.resolve(stored.delete(url));
    },
  } as unknown as Cache;
  return { cache, stored, deleted };
}

function entry(id: number, body: string): Entry {
  return {
    id,
    feedId: 1,
    url: `https://example.com/${id}`,
    title: `記事 ${id}`,
    author: null,
    body,
    publishedAt: null,
    storedAt: 0,
  };
}

describe('extractImageUrls', () => {
  it('サニタイズ済みの本文から img の src を読む順に拾う', () => {
    const html =
      '<p>本文</p><img src="https://img.example.com/a.jpg" alt="a">' +
      '<figure><img alt="b" title="t" src="https://img.example.com/b.png"></figure>';
    expect(extractImageUrls(html)).toEqual([
      'https://img.example.com/a.jpg',
      'https://img.example.com/b.png',
    ]);
  });

  it('温める意味の無い src は落とす', () => {
    // data: は本文と一緒に手元にあり、相対 URL はサニタイズ済みの本文には残らない
    const html = '<img src="data:image/gif;base64,AAAA"><img src="/local.png">';
    expect(extractImageUrls(html)).toEqual([]);
  });

  it('画像が無ければ空', () => {
    expect(extractImageUrls('<p>テクノエッジは要約しか配信しない</p>')).toEqual([]);
  });

  it('文字参照を解く（解かないとブラウザが要求する URL とずれる）', () => {
    // クエリ付きの画像 URL は珍しくなく、フィードは & を実体で書いてよい。
    // 生のまま温めると、存在しない URL を叩いたうえで本物はどこにも温まらない
    expect(extractImageUrls('<img src="https://img.example.com/a.jpg?w=800&amp;h=600">')).toEqual([
      'https://img.example.com/a.jpg?w=800&h=600',
    ]);
    // 数値参照。本番のフィードに &#x26; を使うものが実際にあった
    expect(
      extractImageUrls(
        '<img src="https://img.example.com/a.jpg?w=256&#x26;q=75">' +
          '<img src="https://img.example.com/b.jpg?w=1&#38;h=2">',
      ),
    ).toEqual([
      'https://img.example.com/a.jpg?w=256&q=75',
      'https://img.example.com/b.jpg?w=1&h=2',
    ]);
    // 生の & はそのまま（実体になっていないものを勝手に解釈しない）
    expect(extractImageUrls('<img src="https://img.example.com/a.jpg?w=1&h=2">')).toEqual([
      'https://img.example.com/a.jpg?w=1&h=2',
    ]);
  });
});

describe('imageUrlsOf', () => {
  it('同じ記事なら同じ配列を返す（記事送りのたびに数え直さない）', () => {
    const target = entry(1, '<img src="https://img.example.com/a.jpg">');
    expect(imageUrlsOf(target)).toBe(imageUrlsOf(target));
  });

  it('本文が差し替わった記事は拾い直す', () => {
    // 全文取得（M7 後半）で body が入れ替わると、記事は別のオブジェクトとして届く
    const summary = entry(1, '<p>要約</p>');
    const full = entry(1, '<img src="https://img.example.com/a.jpg">');
    expect(imageUrlsOf(summary)).toEqual([]);
    expect(imageUrlsOf(full)).toEqual(['https://img.example.com/a.jpg']);
  });
});

describe('createImagePrefetcher', () => {
  it('ウィンドウ内の画像を Cache API に温める', async () => {
    const { impl, calls } = recordingFetch();
    const { cache, stored } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
    });

    prefetcher.update(['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg']);
    await prefetcher.idle();

    expect(calls).toEqual(['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg']);
    expect([...stored]).toEqual(['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg']);
  });

  it('同じ URL は 1 回しか取りに行かない', async () => {
    // 複数の記事が同じ画像を使うことは珍しくない。LDRoid が残していた TODO にあたる
    const { impl, calls } = recordingFetch();
    const { cache } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
    });

    prefetcher.update(['https://img.example.com/a.jpg', 'https://img.example.com/a.jpg']);
    await prefetcher.idle();
    // 温め済みになった後にもう一度ウィンドウへ入っても取り直さない
    prefetcher.update(['https://img.example.com/a.jpg']);
    await prefetcher.idle();

    expect(calls).toEqual(['https://img.example.com/a.jpg']);
  });

  it('取りに行くのを並列度までに絞る', async () => {
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const impl = (() => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise<Response>((resolve) => {
        release.push(() => {
          running -= 1;
          resolve(new Response(null, { status: 200 }));
        });
      });
    }) as typeof fetch;

    const { cache } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
      concurrency: 2,
    });
    const urls = Array.from({ length: 6 }, (_, i) => `https://img.example.com/${i}.jpg`);
    prefetcher.update(urls);

    const idle = prefetcher.idle();
    // 1 本ずつ返して、空いた分だけ次が走ることを確かめる。
    // setTimeout を挟むのは、返した後の続き（Cache への書き込みと次の 1 本の
    // 走り出し）を全て吐き出させてから次を返すため
    for (let i = 0; i < urls.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release.shift()?.();
    }
    await idle;

    expect(peak).toBe(2);
  });

  it('同じサイトへは同時に決めた本数までしか取りに行かない', async () => {
    // 記事画像が数 MB あるサイトでは、並列度いっぱいを 1 サイトに向けると
    // 短時間の集中アクセスになる。窓の広さは変えず、1 サイトあたりの太さを絞る
    const perHostRunning = new Map<string, number>();
    const peakPerHost = new Map<string, number>();
    const release: (() => void)[] = [];
    const impl = ((input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      const running = (perHostRunning.get(host) ?? 0) + 1;
      perHostRunning.set(host, running);
      peakPerHost.set(host, Math.max(peakPerHost.get(host) ?? 0, running));
      return new Promise<Response>((resolve) => {
        release.push(() => {
          perHostRunning.set(host, (perHostRunning.get(host) ?? 1) - 1);
          resolve(new Response(null, { status: 200 }));
        });
      });
    }) as typeof fetch;

    const { cache } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
      concurrency: 4,
      perHost: 1,
    });
    // 同じサイトが窓を埋めている状態。別のサイトの分は待たされない
    const urls = [
      ...Array.from({ length: 5 }, (_, i) => `https://heavy.example.com/${i}.jpg`),
      'https://other.example.com/a.jpg',
    ];
    prefetcher.update(urls);

    const idle = prefetcher.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 重いサイトは 1 本だけ、別のサイトはその裏で同時に走っている
    expect(perHostRunning.get('heavy.example.com')).toBe(1);
    expect(perHostRunning.get('other.example.com')).toBe(1);

    for (let i = 0; i < urls.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release.shift()?.();
    }
    await idle;

    expect(peakPerHost.get('heavy.example.com')).toBe(1);
    expect(peakPerHost.get('other.example.com')).toBe(1);
  });

  it('ウィンドウから外れた画像を Cache API から捨てる', async () => {
    const { impl } = recordingFetch();
    const { cache, stored, deleted } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
    });

    prefetcher.update(['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg']);
    await prefetcher.idle();

    // 読み進めて a がウィンドウの後ろに落ちた
    prefetcher.update(['https://img.example.com/b.jpg', 'https://img.example.com/c.jpg']);
    await prefetcher.idle();

    expect(deleted).toEqual(['https://img.example.com/a.jpg']);
    expect([...stored].sort()).toEqual([
      'https://img.example.com/b.jpg',
      'https://img.example.com/c.jpg',
    ]);
  });

  it('取り終える前にウィンドウから外れたら Cache API に置かない', async () => {
    const pending: ((response: Response) => void)[] = [];
    const impl = ((input: RequestInfo | URL) => {
      if (String(input).endsWith('a.jpg')) {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;

    const { cache, stored } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
    });

    prefetcher.update(['https://img.example.com/a.jpg']);
    prefetcher.update(['https://img.example.com/b.jpg']);
    pending.shift()?.(new Response(null, { status: 200 }));
    await prefetcher.idle();

    expect([...stored]).toEqual(['https://img.example.com/b.jpg']);
  });

  it('Cache API を開くのを待つ間にウィンドウから外れたら置き直さない', async () => {
    // j の直後に k、のように「捨てる」と「置き直す」が並ぶと起きる。置いてしまうと
    // warmed からは既に落ちているので、二度と捨てられない
    const opening: ((cache: Cache | null) => void)[] = [];
    const { cache, stored } = fakeCache();
    const { impl } = recordingFetch();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => new Promise<Cache | null>((resolve) => opening.push(resolve)),
    });

    prefetcher.update(['https://img.example.com/a.jpg']);
    // 取得は終わったが、Cache API を開くのをまだ待っている状態にする
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ここで読み進めて a がウィンドウから落ちる
    prefetcher.update(['https://img.example.com/b.jpg']);
    opening.shift()?.(cache);
    await prefetcher.idle();

    expect([...stored]).toEqual(['https://img.example.com/b.jpg']);
  });

  it('取得に失敗しても後続の先読みを止めない', async () => {
    const calls: string[] = [];
    const impl = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('a.jpg')) return Promise.reject(new Error('接続できない'));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;

    const { cache, stored } = fakeCache();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(cache),
      concurrency: 1,
    });
    prefetcher.update(['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg']);
    await prefetcher.idle();

    expect(calls).toHaveLength(2);
    expect([...stored]).toEqual(['https://img.example.com/b.jpg']);
  });

  it('Cache API が使えなくても取りに行く（HTTP キャッシュは温まる）', async () => {
    const { impl, calls } = recordingFetch();
    const prefetcher = createImagePrefetcher({
      fetchImpl: impl,
      openCache: () => Promise.resolve(null),
    });

    prefetcher.update(['https://img.example.com/a.jpg']);
    await prefetcher.idle();

    expect(calls).toEqual(['https://img.example.com/a.jpg']);
  });
});
