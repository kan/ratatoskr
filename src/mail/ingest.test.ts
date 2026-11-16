import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { selectCrawlTargets } from '../db/feeds';
import { getEntryRows, getFeedRow, resetDb } from '../test/seed';
import { ingestMail } from './ingest';

/**
 * メールマガジンの取り込み（issue #41）。生のメールは手で組み立てる。
 */

const NOW = Math.floor(Date.parse('2026-11-16T00:00:00Z') / 1000);
const ADDRESS = 'reader@example.net';
const mailEnv = { DB: env.DB, EMAIL_ADDRESS: ADDRESS };

function rawMail(options: {
  from?: string;
  subject?: string;
  messageId?: string;
  html?: string;
  text?: string;
}): string {
  const headers = [
    `From: ${options.from ?? 'Example Weekly <news@weekly.example.com>'}`,
    `To: ${ADDRESS}`,
    `Subject: ${options.subject ?? '今週のまとめ'}`,
    `Date: Sun, 15 Nov 2026 09:00:00 +0900`,
    `Message-ID: ${options.messageId ?? '<abc@weekly.example.com>'}`,
    'MIME-Version: 1.0',
  ];
  if (options.html === undefined) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', '', options.text ?? ''].join(
      '\r\n',
    );
  }
  return [
    ...headers,
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.text ?? 'テキスト版',
    '--b',
    'Content-Type: text/html; charset=utf-8',
    '',
    options.html,
    '--b--',
  ].join('\r\n');
}

const deliver = (raw: string, to = ADDRESS, envOverride = mailEnv) =>
  ingestMail(envOverride, { to, raw, rawSize: raw.length }, NOW);

const NEWSLETTER = `<html><body>
<span style="display:none;max-height:0">受信箱に出すだけの一文</span>
<table role="presentation" width="600"><tr><td>
  <p><a href="https://weekly.example.com/issues/42?utm=mail"><span>ブラウザで見る</span></a></p>
  <h1>今週のまとめ</h1>
  <p>本文の段落です。<img src="https://cdn.example.com/photo.jpg" width="560" height="300" alt="写真"></p>
</td></tr></table>
<img src="https://t.example.com/open/xyz.gif" width="1" height="1" alt="">
</body></html>`;

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('ingestMail', () => {
  it('送信者ごとにフィードを作り、メールを記事にする', async () => {
    const outcome = await deliver(rawMail({ html: NEWSLETTER }));
    if (outcome.kind !== 'stored') throw new Error(`入っていない: ${outcome.kind}`);

    const feed = await getFeedRow(env.DB, outcome.feedId);
    expect(feed.url).toBe('mailto:news@weekly.example.com');
    expect(feed.title).toBe('Example Weekly');

    const [entry] = await getEntryRows(env.DB, outcome.feedId);
    expect(entry.title).toBe('今週のまとめ');
    expect(entry.url).toBe('https://weekly.example.com/issues/42?utm=mail');
    expect(entry.published_at).toBe(Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000));
    expect(entry.body).toContain('本文の段落です');
    expect(entry.body).toContain('https://cdn.example.com/photo.jpg');
    // トラッキングピクセル・プレヘッダ・レイアウトの表は持ち込まない
    expect(entry.body).not.toContain('t.example.com');
    expect(entry.body).not.toContain('受信箱に出すだけの一文');
    expect(entry.body).not.toContain('<table');
    expect(entry.body).not.toContain('<td');
  });

  it('同じ Message-ID は 1 件にする。同じ送信者の次のメールは同じフィードに入る', async () => {
    const first = await deliver(rawMail({ html: NEWSLETTER }));
    const again = await deliver(rawMail({ html: NEWSLETTER }));
    const next = await deliver(
      rawMail({
        html: NEWSLETTER.replace('issues/42', 'issues/43'),
        subject: '翌週のまとめ',
        messageId: '<def@weekly.example.com>',
      }),
    );

    expect(again).toMatchObject({ kind: 'stored', inserted: false });
    expect(next).toMatchObject({ kind: 'stored', inserted: true });
    if (first.kind !== 'stored') throw new Error('入っていない');
    expect(await getEntryRows(env.DB, first.feedId)).toHaveLength(2);
  });

  it('テキストだけのメールは段落に分けて入れる', async () => {
    const outcome = await deliver(rawMail({ text: '一段落目\n続き\n\n二段落目 <b>太字</b>' }));
    if (outcome.kind !== 'stored') throw new Error('入っていない');
    const [entry] = await getEntryRows(env.DB, outcome.feedId);
    expect(entry.body).toBe('<p>一段落目<br>続き</p><p>二段落目 &lt;b&gt;太字&lt;/b&gt;</p>');
    expect(entry.url).toBeNull();
  });

  it('設定した宛先以外と、設定が空のときは断る', async () => {
    expect(await deliver(rawMail({ html: NEWSLETTER }), 'other@example.net')).toMatchObject({
      kind: 'rejected',
    });
    expect(
      await deliver(rawMail({ html: NEWSLETTER }), ADDRESS, { ...mailEnv, EMAIL_ADDRESS: '' }),
    ).toMatchObject({ kind: 'rejected' });
  });

  it('停止したフィードに届いたメールは捨てる', async () => {
    const first = await deliver(rawMail({ html: NEWSLETTER }));
    if (first.kind !== 'stored') throw new Error('入っていない');
    await env.DB.prepare('UPDATE feeds SET disabled = 1 WHERE id = ?').bind(first.feedId).run();

    const next = await deliver(
      rawMail({ html: NEWSLETTER, messageId: '<def@weekly.example.com>' }),
    );
    expect(next).toEqual({ kind: 'dropped' });
    expect(await getEntryRows(env.DB, first.feedId)).toHaveLength(1);
  });

  it('訳すことにした送信者のメールは、届いたその場で訳す（issue #42）', async () => {
    const first = await deliver(rawMail({ html: NEWSLETTER }));
    if (first.kind !== 'stored') throw new Error('入っていない');
    await env.DB.prepare('UPDATE feeds SET translate = 1 WHERE id = ?').bind(first.feedId).run();
    const ai = {
      run: (_model: string, input: { messages: { content: string }[] }) => {
        const texts = JSON.parse(input.messages[1].content) as string[];
        return Promise.resolve({ response: JSON.stringify(texts.map((t) => `訳:${t}`)) });
      },
    } as unknown as Ai;

    await ingestMail(
      { ...mailEnv, AI: ai },
      {
        to: ADDRESS,
        raw: rawMail({
          subject: 'Weekly roundup',
          messageId: '<en@weekly.example.com>',
          html: '<p>This week we look at squirrels, trees and the forest canopy.</p>',
        }),
        rawSize: 100,
      },
      NOW,
    );

    const rows = await getEntryRows(env.DB, first.feedId);
    const english = rows.find((row) => row.title === 'Weekly roundup');
    expect(english?.translated_title).toBe('訳:Weekly roundup');
  });

  it('メールのフィードはクロールの対象にしない', async () => {
    await deliver(rawMail({ html: NEWSLETTER }));
    expect(await selectCrawlTargets(env.DB, NOW + 86_400, 20)).toEqual([]);
  });
});
