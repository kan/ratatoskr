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

/**
 * URL ごとの `<head>` を返すスタブ。書いていない URL は空のページ。
 * `asked` に叩いた順が残るので、どこまで遡ったかを見られる。
 *
 * `redirects` を渡すと、その URL は行き先を名乗る（`fetch` の `redirect: 'follow'`
 * と同じ形。リダイレクトの後を基準にできているかの検証に使う）
 */
function recording(
  heads: Record<string, string> = {},
  redirects: Record<string, string> = {},
): { asked: string[]; impl: typeof fetch } {
  const asked: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const response = new Response(page(heads[url] ?? ''), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const target = redirects[url];
    if (target !== undefined) Object.defineProperty(response, 'url', { value: target });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { asked, impl };
}

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body>本文</body></html>`;
}

async function candidates(head: string): Promise<{ url: string; title: string | null }[]> {
  const { result } = await discoverFeed('https://example.com/', stub(page(head), 'text/html'));
  if (result.kind !== 'candidates') throw new Error(`候補ではなく ${result.kind}`);
  return result.candidates;
}

describe('discoverFeed', () => {
  it('フィードそのものを渡されたらそれを使う', async () => {
    const found = await discoverFeed('https://example.com/feed', stub(FEED_XML, 'application/xml'));
    expect(found.result).toMatchObject({
      kind: 'feed',
      title: 'ブログ',
      siteUrl: 'https://example.com/',
    });
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

  it('見つからなければ、パスを 1 段ずつ遡って探す', async () => {
    // note の記事ページ（/user/n/id）にはフィードの在処が書かれておらず、
    // ユーザのページ（/user）にだけ <link rel="alternate"> がある
    const { asked, impl } = recording({
      'https://note.com/info/':
        '<link rel="alternate" type="application/rss+xml" href="/info/rss">',
    });

    const found = await discoverFeed('https://note.com/info/n/n854dddb50a26', impl);

    expect(found.result).toEqual({
      kind: 'candidates',
      candidates: [{ url: 'https://note.com/info/rss', title: null }],
    });
    // 貼られたページではなく上の階層で見つけた。呼び出し側が確認を挟む
    expect(found.viaAncestor).toBe(true);
    expect(found.pageUrl).toBe('https://note.com/info/');
    // 近い方から順に遡り、見つかった時点で止まる
    expect(asked).toEqual([
      'https://note.com/info/n/n854dddb50a26',
      'https://note.com/info/n/',
      'https://note.com/info/',
    ]);
  });

  it('貼られたページ自身で見つかったものには印が付かない', async () => {
    const { impl } = recording({
      'https://example.com/': '<link rel="alternate" type="application/rss+xml" href="/rss">',
    });

    expect(await discoverFeed('https://example.com/', impl)).toMatchObject({ viaAncestor: false });
  });

  it('遡る先がフィードそのものでもよい', async () => {
    const byUrl = ((input: RequestInfo | URL) =>
      String(input) === 'https://example.com/blog/'
        ? Promise.resolve(
            new Response(FEED_XML, { status: 200, headers: { 'content-type': 'text/xml' } }),
          )
        : Promise.resolve(
            new Response(page(''), { status: 200, headers: { 'content-type': 'text/html' } }),
          )) as unknown as typeof fetch;

    const found = await discoverFeed('https://example.com/blog/entry/1', byUrl);

    expect(found.result).toMatchObject({ kind: 'feed', url: 'https://example.com/blog/' });
    // フィードそのものでも、貼られた場所と違うなら確認を挟ませる
    expect(found.viaAncestor).toBe(true);
  });

  it('遡るのは 3 段まで', async () => {
    const { asked, impl } = recording();

    await discoverFeed('https://example.com/a/b/c/d/e', impl);

    // 貼られた URL + 3 段。深い URL で無制限に叩かない
    expect(asked).toEqual([
      'https://example.com/a/b/c/d/e',
      'https://example.com/a/b/c/d/',
      'https://example.com/a/b/c/',
      'https://example.com/a/b/',
    ]);
  });

  it('クエリと目印は遡るときに落とす', async () => {
    const { asked, impl } = recording();

    await discoverFeed('https://example.com/blog/entry?utm=1#top', impl);

    expect(asked.slice(1)).toEqual(['https://example.com/blog/', 'https://example.com/']);
  });

  it('リダイレクトの後の URL から遡る', async () => {
    // 短縮 URL を貼られたとき、元の URL から遡ると短縮サービスのトップページを叩く
    const { asked, impl } = recording({}, { 'https://t.co/xyz': 'https://example.com/blog/entry' });

    await discoverFeed('https://t.co/xyz', impl);

    expect(asked).toEqual([
      'https://t.co/xyz',
      'https://example.com/blog/',
      'https://example.com/',
    ]);
  });

  it('同じページに落ち着いた段は、それ以上引かない', async () => {
    // 「未知のパスは全部トップへ転送」の作りだと、段が違っても同じページになる
    const { asked, impl } = recording(
      {},
      {
        'https://example.com/a/b/': 'https://example.com/',
        'https://example.com/a/': 'https://example.com/',
      },
    );

    await discoverFeed('https://example.com/a/b/c', impl);

    // /a/ は投げてみるまで転送先が分からないので 1 回引く。落ち着き先が既出だと
    // 分かった時点で解析はせず、最後の / は投げる前に飛ばす
    expect(asked).toEqual([
      'https://example.com/a/b/c',
      'https://example.com/a/b/',
      'https://example.com/a/',
    ]);
  });

  it('取得に失敗したときは遡らない', async () => {
    // 何が起きたかをそのまま返す方が直しようがある
    const asked: string[] = [];
    const notFound = ((input: RequestInfo | URL) => {
      asked.push(String(input));
      return Promise.resolve(new Response('nope', { status: 404 }));
    }) as unknown as typeof fetch;

    expect(await discoverFeed('https://example.com/a/b/c', notFound)).toMatchObject({
      result: { kind: 'error' },
    });
    expect(asked).toEqual(['https://example.com/a/b/c']);
  });

  it('取得に失敗したら理由を返す', async () => {
    const failing = (() => Promise.reject(new Error('接続できない'))) as unknown as typeof fetch;
    expect(await discoverFeed('https://example.com/', failing)).toMatchObject({
      result: { kind: 'error' },
    });

    const notFound = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
    expect(await discoverFeed('https://example.com/', notFound)).toMatchObject({
      result: { kind: 'error', message: expect.stringContaining('404') },
    });
  });
});
