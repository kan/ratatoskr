import { describe, expect, it } from 'vitest';
import { asobiTicket } from './asobiticket';
import receptionsJson from './__fixtures__/asobiticket-receptions.json?raw';

/**
 * アソビチケットの受付。フィクスチャは 2026-09 の実際の応答を縮めたもの。
 * 受付前の 1 件（7d0c5a4e-…）だけは、実際の応答に無かったので手で作った。
 */

const NOW = Math.floor(Date.parse('2026-09-23T12:00:00Z') / 1000);
const API_URL = 'https://asobi-ticket.api.app.t-riple.com/api/v1/public/receptions';
const TARGET = {
  url: 'https://asobiticket2.asobistore.jp/booths',
  etag: null,
  lastModified: null,
  contentHash: null,
};

function stub(respond: () => Response): {
  impl: typeof fetch;
  calls: { url: string; headers: Headers }[];
} {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function receptions(): Response {
  return new Response(receptionsJson, {
    headers: { 'content-type': 'application/json', etag: 'W/"v1"' },
  });
}

describe('asobiTicket', () => {
  it('受付中のものだけを、受付開始の新しい順に記事にする', async () => {
    const site = stub(receptions);
    const outcome = await asobiTicket.fetch(TARGET, site.impl, NOW);
    if (outcome.kind !== 'fetched') throw new Error(`取れていない: ${outcome.kind}`);

    expect(site.calls.map((call) => call.url)).toEqual([API_URL]);
    expect(outcome.etag).toBe('W/"v1"');

    // 受付前（7d0c5a4e）と終了（a521dfd3）は入らない
    const { items } = outcome.feed;
    expect(items.map((item) => item.guid)).toEqual([
      'c8ebec95-7950-4db1-8177-05e72fe230d2',
      '32c81b97-dca0-4bf4-a52e-fbb237dc806d',
    ]);
    expect(items[0]).toMatchObject({
      url: 'https://asobiticket2.asobistore.jp/receptions/c8ebec95-7950-4db1-8177-05e72fe230d2',
      title:
        'THE IDOLM@STER CINDERELLA GIRLS 15th ANNIVERSARY ORCHESTRA CONCERT ～ シンデレラの演奏会 ～ ／ アソビストアプレミアム会員先行',
      publishedAt: Math.floor(Date.parse('2026-09-16T12:00:00+09:00') / 1000),
    });
  });

  it('本文に表紙の画像、受付期間、種類、当落発表、受付の案内を並べる', async () => {
    const outcome = await asobiTicket.fetch(TARGET, stub(receptions).impl, NOW);
    if (outcome.kind !== 'fetched') throw new Error(`取れていない: ${outcome.kind}`);
    const [lottery, firstCome] = outcome.feed.items;

    expect(lottery.body).toMatch(
      /^<p><img src="https:\/\/media\.app\.t-riple\.com\/public\/cloudfront\/images\/asobi-ticket\/263b6c69-b183-4d09-ae76-b4eda9351f8f\.png\.1200" alt=""><\/p>/,
    );
    expect(lottery.body).toContain(
      '<ul><li>受付期間: 2026/09/16 12:00 〜 2026/09/27 23:59</li>' +
        '<li>受付の種類: 抽選</li><li>当落発表: 2026/10/08 13:00</li></ul>',
    );
    // 受付の案内はそのまま渡す（サニタイズは取り込みの共通の経路が通す）
    expect(lottery.body).toContain('限定の受付となります。');

    // 表紙の無い先着の受付は、画像も当落発表も出さない
    expect(firstCome.body).toBe(
      '<ul><li>受付期間: 2026/09/11 12:00 〜 2026/09/26 17:00</li><li>受付の種類: 先着</li></ul>' +
        '<p>チケットのお申し込みには『バンダイナムコID』が必要です。</p>',
    );
  });

  it('受付の始まりが保持期間より前のものは、受付中でも入れない', async () => {
    // 読んだ記事は 30 日で消える。入れ直すと、同じ受付が未読として届き直す
    const later = Math.floor(Date.parse('2026-10-14T00:00:00+09:00') / 1000);
    const outcome = await asobiTicket.fetch(TARGET, stub(receptions).impl, later);
    if (outcome.kind !== 'fetched') throw new Error(`取れていない: ${outcome.kind}`);
    // 09-16 開始は 28 日前なので残り、09-11 開始は 33 日前なので落ちる
    expect(outcome.feed.items.map((item) => item.guid)).toEqual([
      'c8ebec95-7950-4db1-8177-05e72fe230d2',
    ]);
  });

  it('WAF に弾かれた（403）ときは、フィードが消えた扱いにしない', async () => {
    const outcome = await asobiTicket.fetch(
      TARGET,
      stub(() => new Response('', { status: 403 })).impl,
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'error', reason: 'other' });
  });

  it('控えていた ETag を送り、304 なら本文を読まない', async () => {
    const site = stub(() => new Response(null, { status: 304 }));
    const outcome = await asobiTicket.fetch({ ...TARGET, etag: 'W/"v1"' }, site.impl, NOW);
    expect(outcome.kind).toBe('notModified');
    expect(site.calls[0].headers.get('if-none-match')).toBe('W/"v1"');
  });

  it('一覧の形が違えば、フィードではない扱いにせず失敗にする', async () => {
    const site = stub(() => new Response('{"errors":[]}', { status: 200 }));
    const outcome = await asobiTicket.fetch(TARGET, site.impl, NOW);
    expect(outcome).toMatchObject({ kind: 'error', reason: 'other' });
  });
});
