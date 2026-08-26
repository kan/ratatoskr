import { describe, expect, it } from 'vitest';
import { discoverFeed } from './discover';

/**
 * フィードの自動検出。ユーザが貼るのはサイトの URL であることの方が多いので、
 * <link rel="alternate"> の書かれ方の揺れを吸収できることを見る。
 */

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>ブログ</title><link>https://example.com/</link></channel></rss>`;

function stub(body: string, type: string): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': type } }),
    )) as unknown as typeof fetch;
}

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body>本文</body></html>`;
}

async function candidates(head: string): Promise<{ url: string; title: string | null }[]> {
  const found = await discoverFeed('https://example.com/', stub(page(head), 'text/html'));
  if (found.kind !== 'candidates') throw new Error(`候補ではなく ${found.kind}`);
  return found.candidates;
}

describe('discoverFeed', () => {
  it('フィードそのものを渡されたらそれを使う', async () => {
    const found = await discoverFeed('https://example.com/feed', stub(FEED_XML, 'application/xml'));
    expect(found).toMatchObject({ kind: 'feed', title: 'ブログ', siteUrl: 'https://example.com/' });
  });

  it('相対 href をページの URL で解決する', async () => {
    expect(
      await candidates('<link rel="alternate" type="application/rss+xml" href="/feed.xml">'),
    ).toEqual([{ url: 'https://example.com/feed.xml', title: null }]);
  });

  it('rel が複数語でも、type の大文字小文字が違っても拾う', async () => {
    expect(
      await candidates(
        '<link rel="Alternate Home" type="Application/Atom+XML" title="Atom" href="https://example.com/atom">',
      ),
    ).toEqual([{ url: 'https://example.com/atom', title: 'Atom' }]);
  });

  it('同じ URL は 1 件にまとめ、順序は HTML の順を保つ', async () => {
    expect(
      await candidates(
        '<link rel="alternate" type="application/rss+xml" href="/b.xml">' +
          '<link rel="alternate" type="application/rss+xml" href="/a.xml">' +
          '<link rel="alternate" type="application/atom+xml" href="/b.xml">',
      ),
    ).toEqual([
      { url: 'https://example.com/b.xml', title: null },
      { url: 'https://example.com/a.xml', title: null },
    ]);
  });

  it('フィード以外の alternate は拾わない', async () => {
    expect(
      await candidates(
        '<link rel="alternate" hreflang="en" href="/en/">' +
          '<link rel="stylesheet" type="text/css" href="/style.css">' +
          '<link rel="icon" href="/favicon.ico">',
      ),
    ).toEqual([]);
  });

  it('link が無ければ、フィードを指す a を候補にする', async () => {
    // 自動検出用のタグを出さず、人間向けのリンクだけを置くサイトがある
    // （虚構新聞は <a href="index.xml">虚構新聞社のRSSフィード</a>）
    expect(await candidates('<a href="index.xml"><img src="rss.png"> RSSフィード</a>')).toEqual([
      { url: 'https://example.com/index.xml', title: null },
    ]);

    expect(await candidates('<a href="/feed/">購読</a>')).toEqual([
      { url: 'https://example.com/feed/', title: null },
    ]);
  });

  it('link があれば a には落ちない', async () => {
    // <link> の方が確かなので、紛れ込ませない
    expect(
      await candidates(
        '<link rel="alternate" type="application/rss+xml" href="/a.xml">' +
          '<a href="/other.xml">別の xml</a>',
      ),
    ).toEqual([{ url: 'https://example.com/a.xml', title: null }]);
  });

  it('www の有無や http/https の違いで落とさない', async () => {
    // <a> に絶対 URL を書くサイトで、ホスト表記が揺れることがある
    expect(await candidates('<a href="https://www.example.com/index.xml">RSS</a>')).toEqual([
      { url: 'https://www.example.com/index.xml', title: null },
    ]);
  });

  it('同じフィードを目印違いで何度も候補にしない', async () => {
    // <a> には fragment や計測用の付け足しが付く。見た目の同じ選択肢を並べると、
    // 1 件なら無確認で購読できたはずのものをユーザに選ばせることになる
    expect(
      await candidates('<a href="/index.xml">RSS</a><a href="/index.xml#top">RSS</a>'),
    ).toEqual([{ url: 'https://example.com/index.xml', title: null }]);
  });

  it('.rss も拾う', async () => {
    expect(await candidates('<a href="/feed.rss">RSS</a>')).toEqual([
      { url: 'https://example.com/feed.rss', title: null },
    ]);
  });

  it('フィードでない a は候補にしない', async () => {
    expect(
      await candidates(
        '<a href="/sitemap.xml">サイトマップ</a>' +
          '<a href="/opensearch.xml">検索</a>' +
          '<a href="/about.html">このサイトについて</a>' +
          // 外部の購読サービスへのリンク。これを購読してしまうと的外れ
          '<a href="https://feedly.com/i/subscription/feed/https://example.com/rss">Feedly</a>',
      ),
    ).toEqual([]);
  });

  it('取得に失敗したら理由を返す', async () => {
    const failing = (() => Promise.reject(new Error('接続できない'))) as unknown as typeof fetch;
    expect(await discoverFeed('https://example.com/', failing)).toMatchObject({ kind: 'error' });

    const notFound = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
    expect(await discoverFeed('https://example.com/', notFound)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('404'),
    });
  });
});
