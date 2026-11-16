import { describe, expect, it } from 'vitest';
import { inferRecipe } from './infer';
import { parseRecipe, recipeFeed, runRecipe, type Recipe } from './recipe';
import newsListHtml from './__fixtures__/news-list.html?raw';
import nextDataHtml from './__fixtures__/next-data.html?raw';
import idolmasterNewsJson from './__fixtures__/idolmaster-news.json?raw';
import asobiReceptionsJson from './__fixtures__/asobiticket-receptions.json?raw';
import { idolmasterNews } from './idolmaster';

/**
 * 取得定義（issue #40）。定義をなぞる側（recipe.ts）と、ページから定義を推定する側
 * （infer.ts）。
 */

const NOW = Math.floor(Date.parse('2026-11-16T00:00:00Z') / 1000);
const PAGE = 'https://www.example.co.jp/news/';

const TARGET = { url: PAGE, etag: null, lastModified: null, contentHash: null };

function stubRoutes(routes: Record<string, string>): { impl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const prefix = Object.keys(routes).find((key) => url.startsWith(key));
    return Promise.resolve(
      prefix === undefined ? new Response('', { status: 404 }) : new Response(routes[prefix]),
    );
  }) as unknown as typeof fetch;
  return { impl, asked };
}

const HTML_RECIPE: Recipe = {
  version: 1,
  title: 'お知らせ',
  list: {
    url: PAGE,
    format: 'html',
    items: 'ul.news-list > li.news-item',
    fields: {
      url: { selector: 'a', attr: 'href' },
      title: { selector: 'a' },
      publishedAt: { selector: 'time', attr: 'datetime' },
      image: { selector: 'img', attr: 'src' },
    },
  },
};

describe('parseRecipe', () => {
  it('正しい定義をそのまま通す（JSON の文字列でも受ける）', () => {
    expect(parseRecipe(HTML_RECIPE)).toEqual(HTML_RECIPE);
    expect(parseRecipe(JSON.stringify(HTML_RECIPE))).toEqual(HTML_RECIPE);
  });

  it('壊れた定義は理由を返す', () => {
    expect(parseRecipe({})).toMatch(/version/);
    expect(
      parseRecipe({ ...HTML_RECIPE, list: { ...HTML_RECIPE.list, url: 'file:///etc' } }),
    ).toMatch(/list\.url/);
    const noTitle = {
      ...HTML_RECIPE,
      list: { ...HTML_RECIPE.list, fields: { url: HTML_RECIPE.list.fields.url } },
    };
    expect(parseRecipe(noTitle)).toMatch(/title/);
    const jsonWithSelector = {
      ...HTML_RECIPE,
      list: {
        ...HTML_RECIPE.list,
        format: 'json',
        fields: { url: { selector: 'a' }, title: { path: 't' } },
      },
    };
    expect(parseRecipe(jsonWithSelector)).toMatch(/path/);
  });
});

describe('recipeFeed（html）', () => {
  it('記事ごとに URL・見出し・日付・画像を取り、新しい順に並べる', async () => {
    const feed = await recipeFeed(HTML_RECIPE, newsListHtml, PAGE, NOW);

    expect(feed.items.map((item) => item.url)).toEqual([
      'https://www.example.co.jp/news/2026/11/0003.html',
      'https://www.example.co.jp/news/2026/11/0002.html',
      'https://www.example.co.jp/news/2026/10/0001.html',
      'https://www.example.co.jp/news/2026/10/0000.html',
    ]);
    // 画像のリンク（文字が無い）を飛ばして、見出しのリンクの文字を採る。実体参照は戻す
    expect(feed.items[0].title).toBe('冬季休業のお知らせ & 窓口の受付時間について');
    expect(feed.items[0].publishedAt).toBe(Math.floor(Date.parse('2026-11-14T01:00:00Z') / 1000));
    expect(feed.items[0].body).toContain('<img src="https://www.example.co.jp/img/news/0003.jpg"');
  });

  it('区切りで書かれた日付（2026.11.14）も読む', async () => {
    const recipe: Recipe = {
      ...HTML_RECIPE,
      list: {
        ...HTML_RECIPE.list,
        fields: { ...HTML_RECIPE.list.fields, publishedAt: { selector: 'time' } },
      },
    };
    const feed = await recipeFeed(recipe, newsListHtml, PAGE, NOW);
    expect(feed.items[0].publishedAt).toBe(Math.floor(Date.parse('2026-11-13T15:00:00Z') / 1000));
  });
});

describe('runRecipe（裏の API を叩く SPA）', () => {
  it('アイドルマスター公式の一覧を定義で表せる（手書きのソースと同じ記事が出る）', async () => {
    // **表現力の試金石。** 手書きのソース（src/crawler/idolmaster.ts）のうち、
    // トークンを取ってから一覧を引く手順と、記事の同一性・URL・見出し・日付は定義で書ける。
    // 本文（サムネイルを画像の API に付け替える、ブランド名を添える）は書けないので、
    // 手書きのソースは残す
    const recipe = parseRecipe({
      version: 1,
      title: 'アイドルマスター公式 ニュース',
      siteUrl: 'https://idolmaster-official.jp/news',
      steps: [
        {
          url: 'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/cmsbase/Token/get',
          capture: { token: 'data.token' },
        },
      ],
      list: {
        url: 'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list?site=jp&ip=idolmaster&token={token}&data=%7B%22category%22%3A%5B%22NEWS%22%5D%7D&limit=50&start=0',
        format: 'json',
        items: 'data.article_list',
        fields: {
          guid: { path: '_id' },
          url: { path: 'path', template: 'https://idolmaster-official.jp/news/{}' },
          title: { path: 'title' },
          publishedAt: { path: 'startdate' },
        },
      },
    });
    if (typeof recipe === 'string') throw new Error(recipe);

    const routes = {
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/cmsbase/Token/get': JSON.stringify(
        {
          data: { token: 'tok123' },
        },
      ),
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list':
        idolmasterNewsJson,
    };
    const site = stubRoutes(routes);
    const viaRecipe = await runRecipe(recipe, TARGET, site.impl, NOW);
    const viaCode = await idolmasterNews.fetch(TARGET, stubRoutes(routes).impl, NOW);
    if (viaRecipe.kind !== 'fetched' || viaCode.kind !== 'fetched') throw new Error('取れていない');

    expect(new URL(site.asked[1]).searchParams.get('token')).toBe('tok123');
    const pick = (items: typeof viaCode.feed.items) =>
      items.map(({ guid, url, title, publishedAt }) => ({ guid, url, title, publishedAt }));
    expect(pick(viaRecipe.feed.items)).toEqual(pick(viaCode.feed.items));
  });

  it('条件に合う記事だけを採る（アソビチケットの受付中の絞り込み）', async () => {
    const recipe = parseRecipe({
      version: 1,
      list: {
        url: 'https://asobi-ticket.api.app.t-riple.com/api/v1/public/receptions',
        format: 'json',
        items: 'data',
        fields: {
          guid: { path: 'id' },
          url: { path: 'id', template: 'https://asobiticket2.asobistore.jp/receptions/{}' },
          title: { path: 'attributes.name' },
          publishedAt: { path: 'attributes.entry_period_starts_at' },
        },
        filter: [{ path: 'attributes.entry_period_status', equals: 'within_entry_period' }],
      },
    });
    if (typeof recipe === 'string') throw new Error(recipe);

    const outcome = await runRecipe(
      recipe,
      TARGET,
      stubRoutes({ 'https://asobi-ticket.api.app.t-riple.com/': asobiReceptionsJson }).impl,
      NOW,
    );
    if (outcome.kind !== 'fetched') throw new Error('取れていない');
    const all = (JSON.parse(asobiReceptionsJson) as { data: unknown[] }).data.length;
    expect(outcome.feed.items.length).toBeGreaterThan(0);
    expect(outcome.feed.items.length).toBeLessThan(all);
  });

  it('前段で値が取れなければ、どこで駄目だったかを添えて失敗にする', async () => {
    const recipe = parseRecipe({
      version: 1,
      steps: [{ url: 'https://api.example.com/token', capture: { token: 'data.token' } }],
      list: {
        url: 'https://api.example.com/list?t={token}',
        format: 'json',
        items: '',
        fields: { url: { path: 'u' }, title: { path: 't' } },
      },
    });
    if (typeof recipe === 'string') throw new Error(recipe);
    const outcome = await runRecipe(
      recipe,
      TARGET,
      stubRoutes({ 'https://api.example.com/token': '{}' }).impl,
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'error', reason: 'other' });
    if (outcome.kind === 'error') expect(outcome.message).toContain('token');
  });
});

describe('inferRecipe', () => {
  it('静的な HTML の一覧を見つける。ナビとフッタのリンクの並びは選ばない', async () => {
    const inferred = await inferRecipe(newsListHtml, PAGE, 'お知らせ一覧', undefined, NOW);
    expect(inferred?.source).toBe('score');
    expect(inferred?.recipe.list.format).toBe('html');
    expect(inferred?.feed.items.map((item) => item.title)).toEqual([
      '冬季休業のお知らせ & 窓口の受付時間について',
      '新製品「リス型ロボット」の発売日が決まりました',
      'ウェブサイトをリニューアルしました',
      '秋の展示会に出展します',
    ]);
    expect(inferred?.feed.items[0].publishedAt).not.toBeNull();
    // 推定した定義は、検証を通る形で保存できる
    expect(typeof parseRecipe(inferred?.recipe)).toBe('object');
  });

  it('埋め込まれた JSON（__NEXT_DATA__）の記事の配列を見つける', async () => {
    const page = 'https://example.com/blog';
    const inferred = await inferRecipe(nextDataHtml, page, 'Blog', undefined, NOW);
    expect(inferred?.recipe.list).toMatchObject({
      format: 'embedded-json',
      script: 'script#__NEXT_DATA__',
      items: 'props.pageProps.posts',
    });
    expect(inferred?.feed.items.map((item) => item.url)).toEqual([
      'https://example.com/blog/third',
      'https://example.com/blog/second',
      'https://example.com/blog/first',
    ]);
    // 要約の中の HTML はテキストとして入る（取り込みで改めてサニタイズされる）
    expect(inferred?.feed.items[0].body).toContain('&lt;b&gt;');
  });

  it('候補が複数あれば AI に選ばせる。答えが読めなければ点数の 1 位', async () => {
    const pick = (answer: string): Ai =>
      ({ run: () => Promise.resolve({ response: answer }) }) as unknown as Ai;
    const html = newsListHtml.replace(
      '</main>',
      `<section class="pickup"><h2>注目</h2><div class="cards">
        <div class="card"><a href="/pickup/a">注目の記事その一です</a></div>
        <div class="card"><a href="/pickup/b">注目の記事その二です</a></div>
        <div class="card"><a href="/pickup/c">注目の記事その三です</a></div>
      </div></section></main>`,
    );
    const viaScore = await inferRecipe(html, PAGE, '', pick('どれでもない'), NOW);
    expect(viaScore?.source).toBe('score');
    const viaAi = await inferRecipe(html, PAGE, '', pick('2'), NOW);
    expect(viaAi?.source).toBe('ai');
    expect(viaAi?.recipe).not.toEqual(viaScore?.recipe);
  });

  it('一覧らしいものが無ければ null', async () => {
    const html = '<html><body><p>本文だけのページ</p><a href="/a">ひとつだけ</a></body></html>';
    expect(await inferRecipe(html, PAGE, '', undefined, NOW)).toBeNull();
  });
});
