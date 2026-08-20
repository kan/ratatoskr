import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateFeedResponse,
  FeedCandidatesResponse,
  FeedResponse,
  FetchFeedResponse,
} from '../../shared/types';
import { markFullTextSuggested, selectFeedById } from '../db/feeds';
import { apiSend } from '../test/request';
import { getEntryRows, getFeedRow, seedEntry, seedFeed } from '../test/seed';

/**
 * 購読管理。フィードの自動検出と初回クロールが絡むので、外向きの fetch は
 * グローバルごと差し替える（このバージョンの pool-workers に fetchMock は無い）。
 */

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>テストブログ</title>
    <link>https://blog.example.com/</link>
    <!-- フィードは新しい記事から並べるのが通例。取り込みでは逆順にして、
         古い記事ほど小さい id を持たせる（読む順序 = id の順） -->
    <item>
      <title>新しい記事</title>
      <link>https://blog.example.com/2</link>
      <guid>https://blog.example.com/2</guid>
    </item>
    <item>
      <title>古い記事</title>
      <link>https://blog.example.com/1</link>
      <guid>https://blog.example.com/1</guid>
    </item>
  </channel>
</rss>`;

function html(links: string): string {
  return `<!doctype html><html><head><title>サイト</title>${links}</head><body>本文</body></html>`;
}

/** URL → 応答の対応表で fetch を差し替える。表に無い URL は 404 にする */
function stubFetch(routes: Record<string, { body: string; type: string }>): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const found = routes[url];
    if (found === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(
      new Response(found.body, { status: 200, headers: { 'content-type': found.type } }),
    );
  });
}

const XML = 'application/xml';
const HTML = 'text/html';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/feeds', () => {
  it('フィード URL をそのまま登録し、初回クロールまで済ませて返す', async () => {
    stubFetch({ 'https://blog.example.com/feed.xml': { body: FEED_XML, type: XML } });

    const response = await apiSend('POST', '/api/feeds', {
      url: 'https://blog.example.com/feed.xml',
      rate: 5,
      folder: 'tech',
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateFeedResponse;
    expect(body.feed).toMatchObject({
      url: 'https://blog.example.com/feed.xml',
      title: 'テストブログ',
      rate: 5,
      folder: 'tech',
      readSeq: 0,
      unreadCount: 2,
    });
    // 登録直後から読める状態で返す（docs/API.md）。並びは古い順
    expect(body.entries.map((entry) => entry.title)).toEqual(['古い記事', '新しい記事']);
  });

  it('サイト URL からフィードを見つけて登録する', async () => {
    stubFetch({
      'https://blog.example.com/': {
        // title は「Atom」「RSS」のような総称であることが多い。名前には使わない
        body: html(
          '<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">',
        ),
        type: HTML,
      },
      'https://blog.example.com/feed.xml': { body: FEED_XML, type: XML },
    });

    const response = await apiSend('POST', '/api/feeds', { url: 'blog.example.com' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateFeedResponse;
    // スキームの省略は補い、相対 href はサイト URL で解決する
    expect(body.feed.url).toBe('https://blog.example.com/feed.xml');
    // 名前はフィード自身の名乗りを使う
    expect(body.feed.title).toBe('テストブログ');
  });

  it('候補が複数あるときは登録せず候補を返す', async () => {
    stubFetch({
      'https://blog.example.com/': {
        body: html(
          '<link rel="alternate" type="application/rss+xml" title="記事" href="/feed.xml">' +
            '<link rel="alternate" type="application/atom+xml" title="コメント" href="/comments.xml">',
        ),
        type: HTML,
      },
    });

    const response = await apiSend('POST', '/api/feeds', { url: 'https://blog.example.com/' });
    expect(response.status).toBe(300);
    const body = (await response.json()) as FeedCandidatesResponse;
    expect(body.candidates).toEqual([
      { url: 'https://blog.example.com/feed.xml', title: '記事' },
      { url: 'https://blog.example.com/comments.xml', title: 'コメント' },
    ]);
  });

  it('フィードが見つからないページは 404', async () => {
    stubFetch({ 'https://blog.example.com/': { body: html(''), type: HTML } });
    const response = await apiSend('POST', '/api/feeds', { url: 'https://blog.example.com/' });
    expect(response.status).toBe(404);
  });

  it('取得そのものに失敗したら 502', async () => {
    stubFetch({});
    const response = await apiSend('POST', '/api/feeds', { url: 'https://blog.example.com/' });
    expect(response.status).toBe(502);
  });

  it('購読済みの URL は 409', async () => {
    await seedFeed(env.DB, 'https://blog.example.com/feed.xml');
    stubFetch({ 'https://blog.example.com/feed.xml': { body: FEED_XML, type: XML } });

    const response = await apiSend('POST', '/api/feeds', {
      url: 'https://blog.example.com/feed.xml',
    });
    expect(response.status).toBe(409);
  });

  it('URL とレートを検証する', async () => {
    expect((await apiSend('POST', '/api/feeds', {})).status).toBe(400);
    expect((await apiSend('POST', '/api/feeds', { url: '   ' })).status).toBe(400);
    // file: や data: を取りに行かせない
    expect((await apiSend('POST', '/api/feeds', { url: 'file:///etc/passwd' })).status).toBe(400);
    expect(
      (await apiSend('POST', '/api/feeds', { url: 'https://a.example.com/', rate: 9 })).status,
    ).toBe(400);
  });
});

describe('PATCH /api/feeds/:id', () => {
  it('指定した項目だけを更新する', async () => {
    const id = await seedFeed(env.DB, 'https://patch.example.com/feed', {
      title: 'もとの名前',
      rate: 3,
    });

    const response = await apiSend('PATCH', `/api/feeds/${id}`, { rate: 5, folder: 'tech' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as FeedResponse;
    expect(body.feed).toMatchObject({ rate: 5, folder: 'tech', title: 'もとの名前' });
  });

  it('無効化を解除したら次の取得対象に戻す', async () => {
    const id = await seedFeed(env.DB, 'https://revive.example.com/feed', {
      disabled: 1,
      consecutiveFailures: 21,
      nextFetchAt: 4_000_000_000,
    });

    await apiSend('PATCH', `/api/feeds/${id}`, { disabled: false });
    const row = await getFeedRow(env.DB, id);
    expect(row).toMatchObject({ disabled: 0, consecutive_failures: 0, next_fetch_at: 0 });
  });

  it('存在しない id は 404、範囲外のレートは 400', async () => {
    expect((await apiSend('PATCH', '/api/feeds/999999', { rate: 1 })).status).toBe(404);

    const id = await seedFeed(env.DB, 'https://bad.example.com/feed');
    expect((await apiSend('PATCH', `/api/feeds/${id}`, { rate: 0 })).status).toBe(400);
    expect((await apiSend('PATCH', `/api/feeds/${id}`, { title: '' })).status).toBe(400);
  });
});

describe('DELETE /api/feeds/:id', () => {
  it('記事ごと消す', async () => {
    const id = await seedFeed(env.DB, 'https://gone.example.com/feed');
    stubFetch({ 'https://gone.example.com/feed': { body: FEED_XML, type: XML } });
    await apiSend('POST', `/api/feeds/${id}/fetch`);
    expect(await getEntryRows(env.DB, id)).toHaveLength(2);

    expect((await apiSend('DELETE', `/api/feeds/${id}`)).status).toBe(200);
    expect(await getEntryRows(env.DB, id)).toHaveLength(0);
    expect((await apiSend('DELETE', `/api/feeds/${id}`)).status).toBe(404);
  });
});

describe('POST /api/feeds/:id/fetch', () => {
  it('next_fetch_at を無視して取りに行き、増えた記事を返す', async () => {
    const id = await seedFeed(env.DB, 'https://manual.example.com/feed', {
      // 通常の cron ではまだ拾われない時刻
      nextFetchAt: 4_000_000_000,
    });
    stubFetch({ 'https://manual.example.com/feed': { body: FEED_XML, type: XML } });

    const response = await apiSend('POST', `/api/feeds/${id}/fetch`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as FetchFeedResponse;
    expect(body.entries.map((entry) => entry.title)).toEqual(['古い記事', '新しい記事']);
    expect(body.feed.unreadCount).toBe(2);

    // 2 回目は新着が無いので空。既にある記事を返さない
    const again = (await (
      await apiSend('POST', `/api/feeds/${id}/fetch`)
    ).json()) as FetchFeedResponse;
    expect(again.entries).toEqual([]);
  });

  it('存在しない id は 404', async () => {
    expect((await apiSend('POST', '/api/feeds/999999/fetch')).status).toBe(404);
  });
});

/**
 * 全文取得の設定（M7）。取得そのものは src/crawler/fulltext.test.ts で見ているので、
 * ここでは「設定を切ったときに元へ戻せること」だけを見る。
 */
describe('PATCH /api/feeds/:id の fullText', () => {
  it('切ると、取ってあった本文も捨ててフィードの配信内容に戻る', async () => {
    const id = await seedFeed(env.DB, 'https://full.example.com/feed', { fullText: 1 });
    const entryId = await seedEntry(env.DB, id, { body: '<p>要約</p>' });
    await env.DB.prepare('UPDATE entries SET full_body = ? WHERE id = ?')
      .bind('<p>記事ページから取った本文</p>', entryId)
      .run();

    const response = await apiSend('PATCH', `/api/feeds/${id}`, { fullText: false });
    expect(response.status).toBe(200);

    // 読み出しは COALESCE なので、捨てないと切っても差し替わったままになる。
    // 抽出が本文でないものを掴んでいたときの戻し道が要る
    expect((await getEntryRows(env.DB, id))[0].full_body).toBeNull();
  });

  it('ユーザが決めたら、次のクロールで勧めが復活しない', async () => {
    const id = await seedFeed(env.DB, 'https://full.example.com/feed2');
    await apiSend('PATCH', `/api/feeds/${id}`, { fullText: false });

    // クロールが「要約しか配信していない」と判定しても、断った後なので勧め直さない
    await markFullTextSuggested(env.DB, id);

    const feed = await selectFeedById(env.DB, id);
    expect(feed?.fullTextSuggested).toBe(false);
  });

  it('真偽値以外は 400', async () => {
    const id = await seedFeed(env.DB, 'https://full.example.com/feed3');
    expect((await apiSend('PATCH', `/api/feeds/${id}`, { fullText: 'yes' })).status).toBe(400);
  });
});
