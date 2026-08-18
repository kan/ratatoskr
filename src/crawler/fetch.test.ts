import { describe, expect, it } from 'vitest';
import { describeNetworkError, fetchFeed } from './fetch';

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
