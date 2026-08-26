import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { selectEntriesByIds } from '../db/entries';
import { selectCrawlTargetsByIds } from '../db/feeds';
import { getEntryRows, getFeedRow, resetDb, seedEntry, seedFeed, setReadSeq } from '../test/seed';
import type { FetchBudget } from './fetch';
import { fillFullText, looksSummaryOnly } from './fulltext';

/**
 * 記事ページからの本文取得（M7）。
 *
 * 見るのは「取れた分だけ埋まること」「相手のサーバに取りに行く数が上限で止まること」
 * 「外した抽出で読めるものを減らさないこと」。本文の切り出しそのものは
 * extract.test.ts が実際の記事ページで見ている。
 */

/** 本文 1 段落ぶんの記事ページ。selector を当てれば本文だけが取れる */
function articlePage(text: string): string {
  return `<!doctype html><html><body>
    <nav class="global"><a href="/">トップ</a>ナビの文字</nav>
    <div class="wrap"><article class="entry"><p>${text}</p></article></div>
    <footer>フッタの文字</footer>
  </body></html>`;
}

/**
 * 1 ページに 2 記事が並ぶ日記型のページ。**どの記事かはフラグメントが決める。**
 * 結城浩の日記（d.hyuki.com）がこの形で、本文の入れ物は記事の数だけ存在する。
 */
function diaryPage(first: string, second: string): string {
  const entry = (anchor: string, text: string): string => `<article class="entry">
      <h2><a id="${anchor}" name="${anchor}">見出し</a></h2>
      <div class="content"><p>${text}</p></div>
    </article>`;
  return `<!doctype html><html><body>
    <div class="profile"><p>著者のプロフィール。ページのどこにでも付いてくる短い紹介文。</p></div>
    ${entry('p01', first)}
    ${entry('p02', second)}
  </body></html>`;
}

function stubFetch(pages: Record<string, string>): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const page = pages[url];
    if (page === undefined) return new Response('not found', { status: 404 });
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

/** 常に同じ番号を返す Workers AI。番号は候補一覧の並び順 */
function stubAi(choice: number): Ai {
  return { run: () => Promise.resolve({ response: String(choice) }) } as unknown as Ai;
}

async function targetOf(id: number) {
  const [target] = await selectCrawlTargetsByIds(env.DB, [id]);
  return target;
}

const SUMMARY = '<p>要約</p>';
/** 段落としては数えられるが、フィードの本文より短い抽出。採らない側の検証に使う */
const SHORT_EXTRACT = '本文の入れ物には当たったが、これだけしか取れなかった短い文。';
const BODY = 'これは記事ページにしか無い本文です。'.repeat(10);

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('fillFullText', () => {
  it('未読の記事ページから本文を取り、full_body に入れる', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });
    const budget: FetchBudget = { remaining: 10 };

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget,
    });

    expect(result.filled).toHaveLength(1);
    const [entry] = await getEntryRows(env.DB, feedId);
    expect(entry.full_body).toContain('記事ページにしか無い本文');
    // フィードが配信した本文はそのまま残す（設定を戻せば元に戻せる）
    expect(entry.body).toBe(SUMMARY);
    // 本文の外にある文字は持ち込まない
    expect(entry.full_body).not.toContain('ナビの文字');
  });

  it('1 ページに複数の記事が並ぶサイトで、記事ごとに違う本文を採る', async () => {
    const page = 'https://example.com/202509.html';
    const first = 'ひとつ目の記事にしか無い本文です。'.repeat(10);
    const second = 'ふたつ目の記事にしか無い本文です。'.repeat(10);

    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: `${page}#p01`, body: SUMMARY });
    await seedEntry(env.DB, feedId, { url: `${page}#p02`, body: SUMMARY });
    const html = diaryPage(first, second);
    // 取りに行くのはページの URL。フラグメントは HTTP では送られない
    const stub = stubFetch({ [page]: html });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toHaveLength(2);
    // 同じページを指す記事はまとめて 1 回だけ取る（相手のサーバへの礼儀）
    expect(stub.calls).toEqual([page]);
    // 記事の中を見れば本文の入れ物が一意に名指しできる。
    // ページ全体を見ると div.content は 2 つあって候補にならない
    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBe('div.content');

    const rows = await getEntryRows(env.DB, feedId);
    const bodyOf = (url: string): string =>
      rows.find((row) => row.url === url)!.full_body as string;
    // フラグメントを見ないと、両方が 1 件目の本文で埋まる。それが元の不具合だった
    expect(bodyOf(`${page}#p01`)).toContain('ひとつ目');
    expect(bodyOf(`${page}#p01`)).not.toContain('ふたつ目');
    expect(bodyOf(`${page}#p02`)).toContain('ふたつ目');
    expect(bodyOf(`${page}#p02`)).not.toContain('ひとつ目');
  });

  it('文章の無い記事が先頭に来ても、他の記事でセレクタを決める', async () => {
    // 日記型のサイトには「リンクを 1 本貼っただけ」の記事が普通に混ざる。
    // 1 本目だけを見てセレクタを決めると、その回に取れた記事を全部諦めることになる
    const page = 'https://example.com/202509.html';
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: `${page}#p01`, body: SUMMARY });
    await seedEntry(env.DB, feedId, { url: `${page}#p02`, body: SUMMARY });
    const html = diaryPage(
      '<a href="https://example.com/x">リンクだけの記事</a>',
      'ふたつ目の記事にしか無い本文です。'.repeat(10),
    );
    const stub = stubFetch({ [page]: html });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBe('div.content');
    // セレクタさえ決まれば、リンクだけの記事もその記事の中身として採れる
    expect(result.filled).toHaveLength(2);
    const rows = await getEntryRows(env.DB, feedId);
    expect(rows.find((row) => row.url === `${page}#p01`)!.full_body).toContain('リンクだけの記事');
    expect(rows.find((row) => row.url === `${page}#p02`)!.full_body).toContain('ふたつ目');
  });

  it('記事を指さないフラグメントでは、絞らずに本文を選ぶ', async () => {
    // 記事 URL の # は記事を指すとは限らない。#comments で絞ると本文が候補から
    // 消えてコメント欄が選ばれる。絞った場合と絞らない場合を比べて点の高い方を採る
    const url = 'https://example.com/article/1#comments';
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url, body: SUMMARY });
    const html = `<!doctype html><html><body>
      <article class="post"><div class="body"><p>${'記事ページにしか無い本文です。'.repeat(10)}</p></div></article>
      <div id="comments"><div class="c"><p>${'読者からのコメントです。'.repeat(3)}</p></div></div>
    </body></html>`;
    const stub = stubFetch({ 'https://example.com/article/1': html });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toHaveLength(1);
    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBe('div.body');
    const [entry] = await getEntryRows(env.DB, feedId);
    expect(entry.full_body).toContain('記事ページにしか無い本文');
    expect(entry.full_body).not.toContain('コメント');
  });

  it('本文らしい入れ物が無いページでは、外枠を掴まずに見送る', async () => {
    // 本文の入れ物が名指しできず、プロフィールのような外枠しか残らないページ。
    // ここで外枠を採ると、全記事が同じ紹介文で埋まる（実際に踏んだ）
    const page = 'https://example.com/202509.html';
    const long = 'どの入れ物も名指しできない本文です。'.repeat(10);

    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: page, body: SUMMARY });
    const stub = stubFetch({ [page]: diaryPage(long, long) });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toEqual([]);
    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBeNull();
    // 取りに行った印は残す。残さないと毎クロール同じ記事を叩き続ける
    const [entry] = await getEntryRows(env.DB, feedId);
    expect(entry.full_body).toBe('');
    // フィードが配信した要約はそのまま読める
    expect(entry.body).toBe(SUMMARY);
  });

  it('全文取得を入れていないフィードには取りに行かない', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed');
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it('既読の記事は取りに行かない', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    const entryId = await seedEntry(env.DB, feedId, {
      url: 'https://example.com/a',
      body: SUMMARY,
    });
    await setReadSeq(env.DB, feedId, entryId);
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    // 読まないと決めた記事のために相手のサーバへ取りに行かない
    expect(stub.calls).toEqual([]);
  });

  it('cron 1 回で取りに行く数を予算で止める', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    const pages: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) {
      const url = `https://example.com/${i}`;
      await seedEntry(env.DB, feedId, { url, body: SUMMARY });
      pages[url] = articlePage(BODY);
    }
    const stub = stubFetch(pages);
    const budget: FetchBudget = { remaining: 2 };

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget,
    });

    expect(stub.calls).toHaveLength(2);
    expect(result.filled).toHaveLength(2);
    expect(budget.remaining).toBe(0);
  });

  it('取りに行く前に予算を確保する（並列に走っても上限を超えない）', async () => {
    // crawlFeed は 4 本並列で回る。取得を待ってから予算を引くと、
    // 同じ残りを 4 本が同時に読んで上限の 4 倍まで飛ぶ
    const budget: FetchBudget = { remaining: 12 };
    const pages: Record<string, string> = {};
    const feeds = [];
    for (let f = 0; f < 4; f += 1) {
      const feedId = await seedFeed(env.DB, `https://example.com/feed${f}`, { fullText: 1 });
      for (let i = 0; i < 10; i += 1) {
        const url = `https://example.com/${f}/${i}`;
        await seedEntry(env.DB, feedId, { url, body: SUMMARY });
        pages[url] = articlePage(BODY);
      }
      feeds.push(feedId);
    }
    const stub = stubFetch(pages);

    await Promise.all(
      feeds.map(async (feedId) =>
        fillFullText(env.DB, await targetOf(feedId), {
          fetchImpl: stub.impl,
          ai: undefined,
          budget,
        }),
      ),
    );

    expect(stub.calls).toHaveLength(12);
    expect(budget.remaining).toBe(0);
  });

  it('取りに行って失敗した分も予算から引く', async () => {
    // 記事 URL が全滅しているフィード（サイト移転）で毎回叩き続けると
    // サブリクエスト上限に当たる
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    for (let i = 0; i < 3; i += 1) {
      await seedEntry(env.DB, feedId, { url: `https://example.com/gone/${i}`, body: SUMMARY });
    }
    const stub = stubFetch({});
    const budget: FetchBudget = { remaining: 10 };

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget,
    });

    expect(budget.remaining).toBe(7);
  });

  it('取りに行かなかった分は予算に返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });
    const budget: FetchBudget = { remaining: 10 };

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget,
    });

    // 記事は 1 件しか無い。残り 9 件分は他のフィードのために空けておく
    expect(budget.remaining).toBe(9);
  });

  it('読む順（id 昇順）から埋める', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    const pages: Record<string, string> = {};
    const ids: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const url = `https://example.com/${i}`;
      ids.push(await seedEntry(env.DB, feedId, { url, body: SUMMARY }));
      pages[url] = articlePage(BODY);
    }
    const stub = stubFetch(pages);

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 2 },
    });

    // 最初に読む 2 件が埋まる。新しい順にすると、最後に読む分から埋まってしまう
    expect(result.filled).toEqual(ids.slice(0, 2));
  });

  it('採らなかった記事を毎クロール取り直さない', async () => {
    const long = `<p>${'フィードが配信した長い本文。'.repeat(20)}</p>`;
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: long });
    const stub = stubFetch({ 'https://example.com/a': articlePage(SHORT_EXTRACT) });

    for (let i = 0; i < 2; i += 1) {
      await fillFullText(env.DB, await targetOf(feedId), {
        fetchImpl: stub.impl,
        ai: undefined,
        budget: { remaining: 10 },
      });
    }

    // 2 回目は取りに行かない。相手のサーバを 15 分ごとに叩き続けないため
    expect(stub.calls).toHaveLength(1);
    expect((await getEntryRows(env.DB, feedId))[0].full_body).toBe('');
  });

  it('採らなかった記事の本文はフィードの配信内容のまま読める', async () => {
    const long = `<p>${'フィードが配信した長い本文。'.repeat(20)}</p>`;
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    const entryId = await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: long });
    const stub = stubFetch({ 'https://example.com/a': articlePage(SHORT_EXTRACT) });

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    // '' は「取りに行ったが採らなかった」印であって、本文ではない
    const [entry] = await selectEntriesByIds(env.DB, [entryId]);
    expect(entry.body).toBe(long);
  });

  it('当たったが短いだけのときは判定し直さない', async () => {
    const long = `<p>${'フィードが配信した長い本文。'.repeat(20)}</p>`;
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', {
      fullText: 1,
      fullTextSelector: 'article.entry',
    });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: long });
    const stub = stubFetch({ 'https://example.com/a': articlePage(SHORT_EXTRACT) });

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    // セレクタは当たっている。判定し直すと、正しいセレクタを毎回上書きし続ける
    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBe('article.entry');
  });

  it('消えた記事ページには印を残し、他の記事は取り込む', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/gone', body: SUMMARY });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    // /gone だけ 404 を返す
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toHaveLength(1);
    const rows = await getEntryRows(env.DB, feedId);
    // 404 は何度引いても 404。印を残さないと、サイト移転で URL が全滅した
    // フィードの同じ記事を 15 分ごとに叩き続けることになる
    expect(rows.find((row) => row.url?.endsWith('/gone'))?.full_body).toBe('');
  });

  it('一時的な失敗は次の機会に回す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/flaky', body: SUMMARY });
    // 5xx は時間を置けば直りうる。印を付けると、直っても二度と拾えなくなる
    const impl = (() =>
      Promise.resolve(new Response('boom', { status: 503 }))) as unknown as typeof fetch;

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect((await getEntryRows(env.DB, feedId))[0].full_body).toBeNull();
  });

  it('セレクタが当たらない記事にも印を残す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', {
      fullText: 1,
      // 判定し直しても同じ答えになる状況を作る
      fullTextSelector: 'article.entry',
    });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({
      'https://example.com/a':
        '<html><body><section class="other"><p>' +
        '本文の入れ物はあるが、覚えているセレクタには当たらない。'.repeat(3) +
        '</p></section></body></html>',
    });

    for (let i = 0; i < 2; i += 1) {
      await fillFullText(env.DB, await targetOf(feedId), {
        fetchImpl: stub.impl,
        ai: undefined,
        budget: { remaining: 10 },
      });
    }

    // 2 回目は取りに行かない。印が無いと毎クロール取り直しが止まらない
    expect(stub.calls).toHaveLength(1);
  });

  it('フィードの本文より短い抽出は採らない', async () => {
    const long = `<p>${'フィードが配信した長い本文。'.repeat(20)}</p>`;
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: long });
    // 抽出が外れて注釈だけを掴んだ状態
    const stub = stubFetch({ 'https://example.com/a': articlePage(SHORT_EXTRACT) });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    // 入れると読めるものが減る。要約のままにしておく。
    // '' は「取りに行ったが採らなかった」印で、本文としては使われない
    expect(result.filled).toEqual([]);
    const [entry] = await getEntryRows(env.DB, feedId);
    expect(entry.full_body).toBe('');
  });

  it('本文の位置は 1 回だけ判定して覚える', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    const feed = await getFeedRow(env.DB, feedId);
    expect(feed.full_text_selector).toBe('article.entry');
    expect(feed.full_text_source).toBe('score');
  });

  it('AI が選んだ位置を覚える', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', { fullText: 1 });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: stubAi(1),
      budget: { remaining: 10 },
    });

    const feed = await getFeedRow(env.DB, feedId);
    expect(feed.full_text_source).toBe('ai');
  });

  it('覚えていた位置が当たらなくなったら判定し直す', async () => {
    const feedId = await seedFeed(env.DB, 'https://example.com/feed', {
      fullText: 1,
      // サイトが作り替えられて、この class はもう無い
      fullTextSelector: 'article.old-layout',
    });
    await seedEntry(env.DB, feedId, { url: 'https://example.com/a', body: SUMMARY });
    const stub = stubFetch({ 'https://example.com/a': articlePage(BODY) });

    const result = await fillFullText(env.DB, await targetOf(feedId), {
      fetchImpl: stub.impl,
      ai: undefined,
      budget: { remaining: 10 },
    });

    expect(result.filled).toHaveLength(1);
    expect((await getFeedRow(env.DB, feedId)).full_text_selector).toBe('article.entry');
    // 判定し直しても取得はやり直さない（余分に取りに行かない）
    expect(stub.calls).toHaveLength(1);
  });
});

describe('looksSummaryOnly', () => {
  const short = (url: string | null = 'https://example.com/a') => ({ body: SUMMARY, url });

  it('短い記事ばかりなら要約とみなす', () => {
    expect(looksSummaryOnly([short(), short(), short(), short()])).toBe(true);
  });

  it('本文を配っているフィードは対象にしない', () => {
    const long = { body: 'あ'.repeat(2000), url: 'https://example.com/a' };
    expect(looksSummaryOnly([long, long, long])).toBe(false);
  });

  it('1 本だけ長い記事に引きずられない（中央値で見る）', () => {
    const long = { body: 'あ'.repeat(5000), url: 'https://example.com/a' };
    expect(looksSummaryOnly([short(), short(), short(), long])).toBe(true);
  });

  it('記事数が少なければ判断しない', () => {
    expect(looksSummaryOnly([short(), short()])).toBe(false);
  });

  it('記事ページの URL が無ければ取りに行きようがない', () => {
    expect(looksSummaryOnly([short(), short(), short(null)])).toBe(false);
  });
});
