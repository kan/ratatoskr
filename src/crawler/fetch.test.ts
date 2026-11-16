import { describe, expect, it } from 'vitest';
import { bytesOf, EUCJP_NIHONGO, SJIS_NIHONGO } from '../test/bytes';
import {
  describeNetworkError,
  fetchArticlePage,
  fetchFeed,
  MAX_BYTES,
  parseRetryAfter,
} from './fetch';

/**
 * 取得の失敗を、人が読める文言と機械的な分類の両方に落とせること。
 *
 * 分類は購読管理画面の一括解除が対象を選ぶのに使う。「直しようがない失敗」と
 * 「時間を置けば直りうる失敗」を取り違えると、生きているフィードを消してしまう。
 */

const TARGET = {
  url: 'https://example.com/feed',
  etag: null,
  lastModified: null,
  contentHash: null,
};

function stubStatus(status: number, statusText = ''): typeof fetch {
  return (() =>
    Promise.resolve(new Response('nope', { status, statusText }))) as unknown as typeof fetch;
}

function stubThrow(message: string): typeof fetch {
  return (() => Promise.reject(new Error(message))) as unknown as typeof fetch;
}

describe('describeNetworkError', () => {
  it('workerd の internal error は「接続できない」に噛み砕く', () => {
    // 消えたドメインはこの形で返る。reference 付きの原文をそのまま UI に出さない
    const described = describeNetworkError(new Error('internal error; reference = 5lv5rmp4pi7'));
    expect(described.reason).toBe('unreachable');
    expect(described.message).not.toContain('reference');
    expect(described.message).toContain('接続できない');
  });

  it('打ち切りは例外の名前で判定する（文言に依存しない）', () => {
    // AbortSignal.timeout が投げるもの。実際に 15 秒待つテストは全体を遅くするので、
    // ここでは仕様で決まっている例外（TimeoutError）を直接渡して見る
    expect(describeNetworkError(new DOMException('...', 'TimeoutError'))).toMatchObject({
      reason: 'timeout',
    });
  });

  it('打ち切りと接続断は、直りうる失敗として分ける', () => {
    expect(
      describeNetworkError(new Error('The operation was aborted due to timeout')),
    ).toMatchObject({ reason: 'timeout' });
    expect(describeNetworkError(new Error('Network connection lost.'))).toMatchObject({
      reason: 'connection_lost',
    });
  });

  it('知らない例外は other にして原文を残す', () => {
    const described = describeNetworkError(new Error('なにか未知の失敗'));
    expect(described.reason).toBe('other');
    expect(described.message).toContain('なにか未知の失敗');
  });
});

describe('fetchFeed の失敗分類', () => {
  it.each([
    [404, 'not_found'],
    [410, 'not_found'],
    [403, 'forbidden'],
    [401, 'forbidden'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'other'],
  ])('HTTP %i は %s', async (status, reason) => {
    const outcome = await fetchFeed(TARGET, stubStatus(status));
    expect(outcome).toMatchObject({ kind: 'error', reason });
  });

  it('文言にはステータスを残す', async () => {
    const outcome = await fetchFeed(TARGET, stubStatus(404, 'Not Found'));
    expect(outcome).toMatchObject({ message: 'HTTP 404 Not Found' });
  });

  it('接続そのものの失敗も分類する', async () => {
    const outcome = await fetchFeed(TARGET, stubThrow('internal error; reference = abc'));
    expect(outcome).toMatchObject({ kind: 'error', reason: 'unreachable' });
  });
});

/** フィード本体（issue #37）。XML の宣言だけで文字コードを示すフィードを化けさせない */
describe('fetchFeed の文字コード', () => {
  it('XML の宣言で読む（EUC-JP）', async () => {
    const xml = bytesOf(
      '<?xml version="1.0" encoding="EUC-JP"?>\n<rss version="2.0"><channel><title>',
      EUCJP_NIHONGO,
      '</title></channel></rss>',
    );
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(xml, { headers: { 'content-type': 'application/rss+xml' } }));
    const outcome = await fetchFeed(TARGET, fetchImpl);
    expect(outcome).toMatchObject({ kind: 'fetched', body: expect.stringContaining('日本語') });
  });

  it('Content-Type の charset で読む（Shift_JIS）', async () => {
    const xml = bytesOf(
      '<rss version="2.0"><channel><title>',
      SJIS_NIHONGO,
      '</title></channel></rss>',
    );
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(xml, { headers: { 'content-type': 'text/xml; charset=Shift_JIS' } }),
      );
    const outcome = await fetchFeed(TARGET, fetchImpl);
    expect(outcome).toMatchObject({ kind: 'fetched', body: expect.stringContaining('日本語') });
  });
});

/** 全文取得の記事ページ（issue #35）。UTF-8 以外のページを化けさせずに読む */
describe('fetchArticlePage の文字コード', () => {
  function stubPage(body: Uint8Array, contentType: string): typeof fetch {
    return () => Promise.resolve(new Response(body, { headers: { 'content-type': contentType } }));
  }

  it('Content-Type の charset で読む（Shift_JIS）', async () => {
    const page = bytesOf('<p>', SJIS_NIHONGO, '</p>');
    const outcome = await fetchArticlePage(
      'https://example.jp/1',
      stubPage(page, 'text/html; charset=Shift_JIS'),
    );
    expect(outcome).toEqual({ kind: 'ok', html: '<p>日本語</p>' });
  });

  it('<meta> の宣言で読む（EUC-JP）', async () => {
    const page = bytesOf('<meta charset="EUC-JP"><p>', EUCJP_NIHONGO, '</p>');
    const outcome = await fetchArticlePage('https://example.jp/2', stubPage(page, 'text/html'));
    expect(outcome).toMatchObject({ kind: 'ok', html: expect.stringContaining('日本語') });
  });

  it('上限を超える大きさは読まずに次の機会に回す', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('x', {
          headers: { 'content-type': 'text/html', 'content-length': String(MAX_BYTES + 1) },
        }),
      );
    expect(await fetchArticlePage('https://example.jp/3', fetchImpl)).toEqual({ kind: 'retry' });
  });

  it('申告の無い応答は、読みながらバイト数で測って打ち切る', async () => {
    // 「あ」は UTF-8 で 3 バイト。文字数は上限の半分未満だが、バイト数は上限を超える
    const chunk = new TextEncoder().encode('あ'.repeat(256 * 1024));
    const chunks = Math.ceil(MAX_BYTES / chunk.byteLength) + 4;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          if (pulled > chunks) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await fetchArticlePage('https://example.jp/4', fetchImpl)).toEqual({ kind: 'retry' });
    // 超えた時点でやめ、残りの塊は引かない
    expect(pulled).toBeLessThan(chunks);
  });
});

describe('parseRetryAfter（issue #39）', () => {
  const now = Math.floor(Date.parse('2026-11-16T00:00:00Z') / 1000);

  it('秒数と HTTP 日付の両方を読む', () => {
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Mon, 16 Nov 2026 01:00:00 GMT', now)).toBe(3600);
  });

  it('無い・読めない・過去の日付は null', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('Sun, 15 Nov 2026 00:00:00 GMT', now)).toBeNull();
  });
});

describe('fetchFeed の Retry-After（issue #39）', () => {
  it('429 / 503 なら待ち時間を添える。それ以外の失敗には付けない', async () => {
    const respond = (status: number) =>
      (() =>
        Promise.resolve(
          new Response('', { status, headers: { 'retry-after': '600' } }),
        )) as unknown as typeof fetch;

    expect(await fetchFeed(TARGET, respond(429))).toMatchObject({ kind: 'error', retryAfter: 600 });
    expect(await fetchFeed(TARGET, respond(503))).toMatchObject({ kind: 'error', retryAfter: 600 });
    expect(await fetchFeed(TARGET, respond(500))).not.toHaveProperty('retryAfter');
  });
});
