import { describe, expect, it } from 'vitest';
import { fetchIdolmasterArticles, idolmasterArticlePath, idolmasterNews } from './idolmaster';
import articleHtml from './__fixtures__/idolmaster-article.html?raw';
import newsJson from './__fixtures__/idolmaster-news.json?raw';

/**
 * アイドルマスター公式ニュース。フィクスチャは 2026-09 の実際の応答を縮めたもの。
 */

const NOW = Math.floor(Date.parse('2026-09-23T12:00:00Z') / 1000);
const TOKEN_URL = 'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/cmsbase/Token/get';
const TOKEN_JSON = JSON.stringify({ data: { token: 'tok123', limit: NOW + 3600 } });

/** URL の前方一致で応答を返すスタブ。叩いた URL を順に残す */
function stubSite(routes: Record<string, () => Response>): {
  impl: typeof fetch;
  asked: string[];
} {
  const asked: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const prefix = Object.keys(routes).find((key) => url.startsWith(key));
    return Promise.resolve(
      prefix === undefined ? new Response('', { status: 404 }) : routes[prefix](),
    );
  }) as unknown as typeof fetch;
  return { impl, asked };
}

function json(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

const TARGET = {
  url: 'https://idolmaster-official.jp/news',
  etag: null,
  lastModified: null,
  contentHash: null,
};

describe('idolmasterNews', () => {
  it('トークンを取ってから一覧を引き、公開順に並べ直して記事にする', async () => {
    const site = stubSite({
      [TOKEN_URL]: () => json(TOKEN_JSON),
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list': () =>
        json(newsJson),
    });

    const outcome = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    if (outcome.kind !== 'fetched') throw new Error(`取れていない: ${outcome.kind}`);

    expect(site.asked).toHaveLength(2);
    const list = new URL(site.asked[1]);
    expect(list.searchParams.get('token')).toBe('tok123');
    expect(list.searchParams.get('limit')).toBe('50');
    expect(JSON.parse(list.searchParams.get('data') ?? '')).toEqual({ category: ['NEWS'] });

    const { items } = outcome.feed;
    // 一覧は表示日の順（23423 → 23405）で来るが、公開は 23405 の方が後
    expect(items.map((item) => item.guid)).toEqual(['23405', '23423', '23000']);
    expect(items[0]).toMatchObject({
      url: 'https://idolmaster-official.jp/news/01_19812',
      title: '【学マス】#明日までギリギリ100連無料 QUOカードプレゼントキャンペーン開催中！',
      publishedAt: 1789030800,
    });
    expect(outcome.feed.siteUrl).toBe('https://idolmaster-official.jp/news');
  });

  it('サムネイルは画像の API に付け替え、ブランドとカテゴリを添える', async () => {
    const site = stubSite({
      [TOKEN_URL]: () => json(TOKEN_JSON),
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list': () =>
        json(newsJson),
    });
    const outcome = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    if (outcome.kind !== 'fetched') throw new Error(`取れていない: ${outcome.kind}`);

    const body = outcome.feed.items.find((item) => item.guid === '23423')?.body;
    // `?_=` を付けたままだと API が 404 を返すので落とす
    expect(body).toBe(
      '<p><img src="https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Image/get?path=%2Fidolmaster%2Fjp%2Farticle%2F1002%2F2026%2F09%2FOG3lKeg0aYQPkQnWwVuEuys12U2vf69W.jpeg" alt=""></p>' +
        '<p>SideM ／ グッズ、コラボ・キャンペーン</p>',
    );
  });

  it('一覧が前回と同じなら打ち切る', async () => {
    const site = stubSite({
      [TOKEN_URL]: () => json(TOKEN_JSON),
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list': () =>
        json(newsJson),
    });
    const first = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    if (first.kind !== 'fetched') throw new Error(`取れていない: ${first.kind}`);

    const second = await idolmasterNews.fetch(
      { ...TARGET, contentHash: first.contentHash },
      site.impl,
      NOW,
    );
    expect(second.kind).toBe('unchanged');
  });

  it('トークンが取れなければ、何が駄目だったかを添えて失敗にする', async () => {
    const site = stubSite({ [TOKEN_URL]: () => new Response('', { status: 503 }) });
    const outcome = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    expect(outcome).toMatchObject({ kind: 'error', reason: 'server_error' });
    expect(outcome.kind === 'error' && outcome.message).toMatch(/^トークン: HTTP 503/);
    // 一覧は引かない
    expect(site.asked).toHaveLength(1);
  });

  it('API の 404 は、フィードが消えた扱い（一括解除の対象）にしない', async () => {
    const site = stubSite({ [TOKEN_URL]: () => json(TOKEN_JSON) });
    const outcome = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    expect(outcome).toMatchObject({ kind: 'error', reason: 'other' });
    expect(outcome.kind === 'error' && outcome.message).toMatch(/^ニュースの一覧: HTTP 404/);
  });

  it('一覧の形が違えば、フィードではない扱いにせず失敗にする', async () => {
    const site = stubSite({
      [TOKEN_URL]: () => json(TOKEN_JSON),
      // トークンが受け付けられなかったときの実際の応答
      'https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Article/list': () =>
        json('{"statusCode":404,"data":false}'),
    });
    const outcome = await idolmasterNews.fetch(TARGET, site.impl, NOW);
    expect(outcome).toMatchObject({ kind: 'error', reason: 'other' });
  });
});

describe('idolmasterArticlePath', () => {
  it('記事の URL から記事のパスを取り出す', () => {
    expect(idolmasterArticlePath('https://idolmaster-official.jp/news/01_19877')).toBe('01_19877');
    expect(idolmasterArticlePath('https://idolmaster-official.jp/news/01_19877.html')).toBe(
      '01_19877',
    );
  });

  it('記事ではない URL やほかのホストは対象にしない', () => {
    expect(idolmasterArticlePath('https://idolmaster-official.jp/news')).toBeNull();
    expect(idolmasterArticlePath('https://idolmaster-official.jp/live_event/x/')).toBeNull();
    expect(idolmasterArticlePath('https://example.com/news/01_19877')).toBeNull();
    expect(idolmasterArticlePath('http://idolmaster-official.jp/news/01_19877')).toBeNull();
    expect(idolmasterArticlePath('not a url')).toBeNull();
  });
});

describe('fetchIdolmasterArticles', () => {
  const PAGE = 'https://idolmaster-official.jp/news/';

  function html(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/html' } });
  }

  function pageWith(data: Record<string, unknown>): string {
    return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { data } },
    })}</script></body></html>`;
  }

  it('埋め込み JSON の本文を採り、画像を付け替えてサニタイズする', async () => {
    const site = stubSite({ [PAGE]: () => html(articleHtml) });
    const result = await fetchIdolmasterArticles(['01_19877'], site.impl);

    const body = result.bodies.get('01_19877') ?? '';
    expect(body).toContain('プロデューサーさん、こんばんは！');
    expect(body).toContain('<h6>本日のセットリストはコチラ！</h6>');
    expect(body).toContain(
      'src="https://cmsapi-frontend.idolmaster-official.jp/sitern/api/idolmaster/Image/get?path=%2Fidolmaster%2Fjp%2Farticle%2F021%2F2026%2F09%2F8OTAxTA7LQKFy0bWdDjH3umuywtNBbwL.jpeg"',
    );
    // 相対リンクは記事 URL を基準に絶対化される
    expect(body).toContain(
      'href="https://idolmaster-official.jp/live_event/gkmas_livetour_shirube/"',
    );
    // ページの外枠（ナビゲーション）は入らない
    expect(body).not.toContain('読み込み中');
    expect(site.asked).toEqual(['https://idolmaster-official.jp/news/01_19877']);
    expect(result.attempted).toBe(1);
  });

  it('会員限定の記事と消えた記事には印を付け、本文は取り込まない', async () => {
    const site = stubSite({
      [`${PAGE}01_19485`]: () => html(pageWith({ memberflg: '1', content: '<p>限定の本文</p>' })),
      [`${PAGE}01_1`]: () => html('', 404),
    });
    const result = await fetchIdolmasterArticles(['01_19485', '01_1'], site.impl);
    expect(result.bodies.size).toBe(0);
    expect([...result.missing]).toEqual(['01_19485', '01_1']);
  });

  it('埋め込み JSON が無ければ印を付けず、残りも取りに行かない', async () => {
    const site = stubSite({
      [PAGE]: () => html('<html><body><p>作り替えたページ</p></body></html>'),
    });
    const result = await fetchIdolmasterArticles(['01_1', '01_2', '01_3'], site.impl);
    expect(result.bodies.size).toBe(0);
    expect(result.missing.size).toBe(0);
    expect(site.asked).toHaveLength(1);
    // 呼び出し側は、取りに行かなかった 2 件ぶんの枠をこれで返す
    expect(result.attempted).toBe(1);
  });
});
