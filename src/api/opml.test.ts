import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { OpmlImportResponse } from '../../shared/types';
import { apiGet, apiRaw } from '../test/request';
import { getFeedRow, seedFeed } from '../test/seed';

/**
 * OPML の往復（M5 の完了条件）。他のリーダーとの相互運用が目的なので、
 * 標準の属性だけで意味が通ることと、レートが独自属性で残ることを見る。
 */

const OPML_TYPE = 'text/x-opml';

async function importOpml(xml: string, contentType = OPML_TYPE): Promise<OpmlImportResponse> {
  const response = await apiRaw('POST', '/api/opml', {
    headers: { 'content-type': contentType },
    body: xml,
  });
  if (response.status !== 200) {
    throw new Error(`POST /api/opml が ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as OpmlImportResponse;
}

describe('GET /api/opml', () => {
  it('フォルダを入れ子にし、レートを独自属性で出す', async () => {
    await seedFeed(env.DB, 'https://a.example.com/feed', { title: 'あるブログ', rate: 5 });
    await seedFeed(env.DB, 'https://b.example.com/feed', {
      title: 'ニュース',
      rate: 2,
      folder: 'news',
      siteUrl: 'https://b.example.com/',
    });

    const response = await apiGet('/api/opml');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-opml');

    const xml = await response.text();
    // 未分類は body 直下
    expect(xml).toContain('<outline type="rss" text="あるブログ"');
    expect(xml).toContain('xmlUrl="https://a.example.com/feed"');
    expect(xml).toContain('ratatoskr:rate="5"');
    // フォルダは入れ子
    expect(xml).toMatch(/<outline text="news"[^>]*>\s*<outline type="rss" text="ニュース"/);
    expect(xml).toContain('htmlUrl="https://b.example.com/"');
  });

  it('タイトルと URL をエスケープする', async () => {
    await seedFeed(env.DB, 'https://x.example.com/feed?a=1&b=2', { title: '<script> & "引用"' });
    const xml = await (await apiGet('/api/opml')).text();

    expect(xml).toContain('text="&lt;script&gt; &amp; &quot;引用&quot;"');
    expect(xml).toContain('xmlUrl="https://x.example.com/feed?a=1&amp;b=2"');
    expect(xml).not.toContain('<script>');
  });

  it('取り込んだ OPML をそのまま書き出せる（往復）', async () => {
    await importOpml(`<?xml version="1.0"?>
<opml version="2.0" xmlns:ratatoskr="https://github.com/kan/ratatoskr">
  <body>
    <outline text="tech">
      <outline type="rss" text="往復テスト" xmlUrl="https://round.example.com/feed"
               htmlUrl="https://round.example.com/" ratatoskr:rate="4" />
    </outline>
  </body>
</opml>`);

    const xml = await (await apiGet('/api/opml')).text();
    expect(xml).toMatch(/<outline text="tech"[^>]*>\s*<outline type="rss" text="往復テスト"/);
    expect(xml).toContain('ratatoskr:rate="4"');
    expect(xml).toContain('xmlUrl="https://round.example.com/feed"');
  });
});

describe('POST /api/opml', () => {
  const SAMPLE = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>subscriptions</title></head>
  <body>
    <outline type="rss" text="単独" xmlUrl="https://solo.example.com/feed" />
    <outline text="tech">
      <outline type="rss" text="入れ子" xmlUrl="https://nested.example.com/feed" />
    </outline>
  </body>
</opml>`;

  it('フォルダごと取り込む。初回クロールはしない', async () => {
    const result = await importOpml(SAMPLE);
    expect(result).toMatchObject({ imported: 2, skipped: 0, failed: [] });

    const rows = await env.DB.prepare(
      'SELECT url, title, folder, rate, next_fetch_at, last_fetched_at FROM feeds ORDER BY url',
    ).all<{
      url: string;
      title: string;
      folder: string;
      rate: number;
      next_fetch_at: number;
      last_fetched_at: number | null;
    }>();

    expect(rows.results).toEqual([
      {
        url: 'https://nested.example.com/feed',
        title: '入れ子',
        folder: 'tech',
        rate: 3,
        next_fetch_at: 0,
        last_fetched_at: null,
      },
      {
        url: 'https://solo.example.com/feed',
        title: '単独',
        folder: '',
        rate: 3,
        next_fetch_at: 0,
        last_fetched_at: null,
      },
    ]);
  });

  it('レートを持つ OPML はその値で取り込む', async () => {
    await importOpml(`<?xml version="1.0"?>
<opml version="2.0" xmlns:ratatoskr="https://github.com/kan/ratatoskr">
  <body>
    <outline type="rss" text="重要" xmlUrl="https://rate.example.com/feed" ratatoskr:rate="5" />
    <outline type="rss" text="範囲外" xmlUrl="https://bad.example.com/feed" ratatoskr:rate="9" />
  </body>
</opml>`);

    const rows = await env.DB.prepare('SELECT url, rate FROM feeds ORDER BY url').all<{
      url: string;
      rate: number;
    }>();
    expect(rows.results).toEqual([
      // 範囲外は既定の 3 に丸める。取り込み全体を失敗させない
      { url: 'https://bad.example.com/feed', rate: 3 },
      { url: 'https://rate.example.com/feed', rate: 5 },
    ]);
  });

  it('購読済みは飛ばし、壊れた URL は理由付きで返す', async () => {
    const existing = await seedFeed(env.DB, 'https://solo.example.com/feed', { title: '購読済み' });

    const result = await importOpml(`<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline type="rss" text="既にある" xmlUrl="https://solo.example.com/feed" />
    <outline type="rss" text="壊れている" xmlUrl="ftp://old.example.com/feed" />
    <outline type="rss" text="新しい" xmlUrl="https://fresh.example.com/feed" />
  </body>
</opml>`);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([
      { url: 'ftp://old.example.com/feed', reason: 'http か https ではない' },
    ]);
    // 既存のタイトルは OPML で上書きしない
    expect((await getFeedRow(env.DB, existing)).title).toBe('購読済み');
  });

  it('multipart/form-data でも受け取る', async () => {
    const form = new FormData();
    form.set('file', new File([SAMPLE], 'subscriptions.opml', { type: OPML_TYPE }));

    const response = await apiRaw('POST', '/api/opml', { body: form });
    expect(response.status).toBe(200);
    expect((await response.json()) as OpmlImportResponse).toMatchObject({ imported: 2 });
  });

  it('OPML として読めないものは 400', async () => {
    expect(
      (await apiRaw('POST', '/api/opml', { headers: { 'content-type': OPML_TYPE }, body: '' }))
        .status,
    ).toBe(400);
    expect(
      (
        await apiRaw('POST', '/api/opml', {
          headers: { 'content-type': OPML_TYPE },
          body: '<opml><body></body></opml>',
        })
      ).status,
    ).toBe(400);
  });
});
