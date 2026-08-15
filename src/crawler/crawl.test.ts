import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { crawl } from './index';
import { getEntryRows, getFeedRow, resetDb, seedFeed } from '../test/seed';
import rss2Xml from './__fixtures__/rss2.xml?raw';

const NOW = Math.floor(Date.parse('2026-08-05T00:00:00Z') / 1000);

interface StubCall {
  url: string;
  headers: Headers;
}

/** 外に出て行かせない fetch。呼ばれた URL とヘッダを記録する */
function stubFetch(respond: (call: StubCall) => Response): {
  fetch: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const call = { url, headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function xmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml', ...headers },
  });
}

/** rss2.xml に記事を 1 件足したもの。差分取り込みの検証に使う */
function rss2WithExtraItem(): string {
  return rss2Xml.replace(
    '    <item>',
    `    <item>
      <title>もっと新しい記事</title>
      <link>https://example.com/posts/3</link>
      <guid isPermaLink="false">tag:example.com,2026:post-3</guid>
      <pubDate>Wed, 05 Aug 2026 00:00:00 +0900</pubDate>
      <description>追加</description>
    </item>

    <item>`,
  );
}

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('crawl', () => {
  it('記事を取り込み、フィードの取得状態を更新する', async () => {
    const id = await seedFeed(env.DB, 'https://example.com/feed.xml');
    const stub = stubFetch(() => xmlResponse(rss2Xml, { etag: 'W/"v1"' }));

    const summary = await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });
    expect(summary).toMatchObject({ checked: 1, updated: 1, inserted: 2, failed: 0 });

    const entries = await getEntryRows(env.DB, id);
    expect(entries).toHaveLength(2);
    // フィードは新しい順に並ぶので、逆順に入れて古い記事ほど小さい id を持たせる
    expect(entries.map((e) => e.title)).toEqual(['古い記事', '新しい記事']);
    expect(entries[0].id).toBeLessThan(entries[1].id);
    expect(entries[1].url).toBe('https://example.com/posts/2');
    expect(entries[1].author).toBe('kan');
    expect(entries[1].published_at).toBe(Math.floor(Date.parse('2026-08-04T03:34:56Z') / 1000));

    const feed = await getFeedRow(env.DB, id);
    expect(feed.etag).toBe('W/"v1"');
    expect(feed.content_hash).not.toBeNull();
    expect(feed.last_fetched_at).toBe(NOW);
    expect(feed.last_error).toBeNull();
    expect(feed.consecutive_failures).toBe(0);
    // 更新があったので間隔は 15 分に戻る
    expect(feed.fetch_interval).toBe(900);
    expect(feed.next_fetch_at).toBe(NOW + 900);
    // 空だったタイトルはフィードの名乗りで埋める
    expect(feed.title).toBe('テストブログ');
    expect(feed.site_url).toBe('https://example.com/');
  });

  it('本文はサニタイズ済みで、相対リンクが解決されている', async () => {
    const id = await seedFeed(env.DB, 'https://sanitize.example.com/feed.xml');
    const xml = rss2Xml.replace(
      '<![CDATA[<p>本文です。<a href="/posts/1">前の記事</a></p>]]>',
      '<![CDATA[<p onclick="x()">本文</p><script>alert(1)</script><a href="/posts/1">前</a>]]>',
    );
    const stub = stubFetch(() => xmlResponse(xml));

    await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });

    const [, newer] = await getEntryRows(env.DB, id);
    expect(newer.body).not.toContain('<script');
    expect(newer.body).not.toContain('onclick');
    expect(newer.body).toContain('href="https://example.com/posts/1"');
  });

  it('同じ記事を二重に取り込まず、新着だけを追加する', async () => {
    const id = await seedFeed(env.DB, 'https://again.example.com/feed.xml');
    const first = stubFetch(() => xmlResponse(rss2Xml));
    await crawl(env, { now: NOW, feedIds: [id], fetchImpl: first.fetch });

    const second = stubFetch(() => xmlResponse(rss2WithExtraItem()));
    const summary = await crawl(env, { now: NOW + 900, feedIds: [id], fetchImpl: second.fetch });

    expect(summary.inserted).toBe(1);
    const entries = await getEntryRows(env.DB, id);
    expect(entries.map((e) => e.title)).toEqual(['古い記事', '新しい記事', 'もっと新しい記事']);
  });

  it('条件付き GET を送り、304 なら間隔を伸ばす', async () => {
    const id = await seedFeed(env.DB, 'https://cond.example.com/feed.xml', {
      etag: 'W/"v1"',
      lastModified: 'Mon, 03 Aug 2026 00:00:00 GMT',
      fetchInterval: 900,
    });
    const stub = stubFetch(() => new Response(null, { status: 304 }));

    const summary = await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });

    expect(stub.calls[0].headers.get('if-none-match')).toBe('W/"v1"');
    expect(stub.calls[0].headers.get('if-modified-since')).toBe('Mon, 03 Aug 2026 00:00:00 GMT');
    expect(summary).toMatchObject({ inserted: 0, failed: 0 });

    const feed = await getFeedRow(env.DB, id);
    expect(feed.fetch_interval).toBe(1350);
    expect(feed.next_fetch_at).toBe(NOW + 1350);
    expect(feed.last_fetched_at).toBe(NOW);
  });

  it('304 を返さないサーバでも content_hash が同じならパースしない', async () => {
    const id = await seedFeed(env.DB, 'https://hash.example.com/feed.xml');
    await crawl(env, {
      now: NOW,
      feedIds: [id],
      fetchImpl: stubFetch(() => xmlResponse(rss2Xml)).fetch,
    });
    const afterFirst = await getFeedRow(env.DB, id);

    // 同じ本文をもう一度返す。ETag は付けない
    const summary = await crawl(env, {
      now: NOW + 900,
      feedIds: [id],
      fetchImpl: stubFetch(() => xmlResponse(rss2Xml)).fetch,
    });

    expect(summary.inserted).toBe(0);
    expect(await getEntryRows(env.DB, id)).toHaveLength(2);
    const feed = await getFeedRow(env.DB, id);
    expect(feed.content_hash).toBe(afterFirst.content_hash);
    expect(feed.fetch_interval).toBe(1350);
  });

  it('取得に失敗したら last_error に残してバックオフする', async () => {
    const id = await seedFeed(env.DB, 'https://broken.example.com/feed.xml');
    const stub = stubFetch(() => new Response('nope', { status: 500, statusText: 'Server Error' }));

    const summary = await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });
    expect(summary).toMatchObject({ inserted: 0, failed: 1 });

    const feed = await getFeedRow(env.DB, id);
    expect(feed.consecutive_failures).toBe(1);
    expect(feed.last_error).toContain('500');
    expect(feed.next_fetch_at).toBe(NOW + 900);
    expect(feed.disabled).toBe(0);
  });

  it('パースできない応答も失敗として扱う', async () => {
    const id = await seedFeed(env.DB, 'https://html.example.com/feed.xml');
    const stub = stubFetch(() => xmlResponse('<html><body>Not a feed</body></html>'));

    await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });

    const feed = await getFeedRow(env.DB, id);
    expect(feed.consecutive_failures).toBe(1);
    expect(feed.last_error).not.toBeNull();
    expect(await getEntryRows(env.DB, id)).toHaveLength(0);
  });

  it('連続失敗が 20 回を超えたら無効化する', async () => {
    const id = await seedFeed(env.DB, 'https://dead.example.com/feed.xml', {
      consecutiveFailures: 20,
    });
    const stub = stubFetch(() => new Response('', { status: 404 }));

    await crawl(env, { now: NOW, feedIds: [id], fetchImpl: stub.fetch });

    const feed = await getFeedRow(env.DB, id);
    expect(feed.consecutive_failures).toBe(21);
    expect(feed.disabled).toBe(1);
    expect(feed.next_fetch_at).toBe(NOW + 86400);
  });

  it('期限が来ていないフィードは取りに行かない', async () => {
    const due = await seedFeed(env.DB, 'https://due.example.com/feed.xml', { nextFetchAt: NOW });
    const notDue = await seedFeed(env.DB, 'https://notdue.example.com/feed.xml', {
      nextFetchAt: NOW + 1,
    });
    const stub = stubFetch(({ url }) =>
      url.includes('notdue') ? new Response('', { status: 500 }) : xmlResponse(rss2Xml),
    );

    await crawl(env, { now: NOW, fetchImpl: stub.fetch });

    expect(stub.calls.some((call) => call.url.includes('notdue'))).toBe(false);
    expect((await getFeedRow(env.DB, due)).last_fetched_at).toBe(NOW);
    expect((await getFeedRow(env.DB, notDue)).last_fetched_at).toBeNull();
  });

  it('無効化されたフィードは取りに行かない', async () => {
    const id = await seedFeed(env.DB, 'https://disabled.example.com/feed.xml', { disabled: 1 });
    const stub = stubFetch(() => xmlResponse(rss2Xml));

    await crawl(env, { now: NOW, fetchImpl: stub.fetch });

    expect(stub.calls.some((call) => call.url.includes('disabled'))).toBe(false);
    expect((await getFeedRow(env.DB, id)).last_fetched_at).toBeNull();
  });
});
