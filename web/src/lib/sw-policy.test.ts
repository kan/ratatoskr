import { describe, expect, it } from 'vitest';
import { overflowing, routeFor, type RequestFacts } from './sw-policy';

const ORIGIN = 'https://reader.example.com';

function facts(overrides: Partial<RequestFacts> & { url: string }): RequestFacts {
  return {
    method: 'GET',
    origin: ORIGIN,
    destination: '',
    mode: 'cors',
    ...overrides,
  };
}

describe('routeFor', () => {
  it('書き込みには一切触らない', () => {
    // 既読とピンは keepalive / sendBeacon で離脱後も届くことを当てにしている経路。
    // 間に入ると、その保証が Service Worker の実装次第になる（不変条件 3）
    for (const method of ['POST', 'DELETE', 'PATCH', 'PUT']) {
      expect(routeFor(facts({ method, url: `${ORIGIN}/api/read` }))).toBe('bypass');
    }
  });

  it('ナビゲーションはアプリシェルから出す', () => {
    expect(routeFor(facts({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'document' }))).toBe(
      'shell',
    );
  });

  it('手元に控えるのは bootstrap だけ', () => {
    expect(routeFor(facts({ url: `${ORIGIN}/api/bootstrap` }))).toBe('api');
    // 記事の中身は IndexedDB にある。同じものを 2 通りで抱えない
    expect(routeFor(facts({ url: `${ORIGIN}/api/entries?sinceId=0` }))).toBe('bypass');
    expect(routeFor(facts({ url: `${ORIGIN}/api/sync?since=1` }))).toBe('bypass');
    // 書き出しは中身が大きく、控える意味も無い
    expect(routeFor(facts({ url: `${ORIGIN}/api/opml` }))).toBe('bypass');
  });

  it('リンクから開く API をアプリシェルと取り違えない', () => {
    // `<a href="/api/opml">` はナビゲーション要求で届く（wrangler.jsonc の
    // run_worker_first と同じ話）。シェル扱いにすると、書き出した OPML が
    // index.html の代わりに控えられ、次のオフライン起動で画面が出なくなる
    expect(
      routeFor(facts({ url: `${ORIGIN}/api/opml`, mode: 'navigate', destination: 'document' })),
    ).toBe('bypass');
  });

  it('ハッシュ付きの資産は手元優先、それ以外の静的ファイルはネットワーク優先', () => {
    expect(routeFor(facts({ url: `${ORIGIN}/assets/index-abc123.js` }))).toBe('asset');
    expect(routeFor(facts({ url: `${ORIGIN}/manifest.json` }))).toBe('static');
    expect(routeFor(facts({ url: `${ORIGIN}/favicon.svg` }))).toBe('static');
  });

  it('画像として扱うのは外のオリジンのものだけ', () => {
    expect(
      routeFor(
        facts({ url: 'https://img.example.net/1.jpg', destination: 'image', mode: 'no-cors' }),
      ),
    ).toBe('image');
    // 自分のオリジンが配る画像はアプリのアイコン。記事の画像の LRU に混ぜると、
    // 押し出された挙げ句に取り直しもされない
    expect(routeFor(facts({ url: `${ORIGIN}/icon-192.png`, destination: 'image' }))).toBe('static');
  });

  it('外のオリジンの画像以外は素通しする', () => {
    // 埋め込みの解決や外部リンクの先読みまで抱え込まない
    expect(
      routeFor(facts({ url: 'https://example.net/article.html', destination: 'document' })),
    ).toBe('bypass');
    expect(routeFor(facts({ url: 'https://example.net/app.js', destination: 'script' }))).toBe(
      'bypass',
    );
  });
});

describe('overflowing', () => {
  it('上限までは何も捨てない', () => {
    expect(overflowing(['a', 'b'], 2)).toEqual([]);
    expect(overflowing([], 2)).toEqual([]);
  });

  it('超えた分だけ古い順に返す', () => {
    // Cache API の keys() は入れた順。参照したものを入れ直せば最後に使った順になる
    expect(overflowing(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });
});
