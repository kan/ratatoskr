import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '../../shared/types';
import worker from '../index';

// Worker の fetch は IncomingRequest（cf プロパティ付き）を受け取るため、
// テストからはこの別名で生成する（Cloudflare 公式ドキュメントの定石）
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function get(path: string): Promise<Response> {
  const request = new IncomingRequest(`http://localhost${path}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('GET /api/health', () => {
  it('D1 に到達できれば 200 を返す', async () => {
    const response = await get('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
    expect(body.schemaVersion).toBe(1);
    // 時刻は Unix 秒。ミリ秒が混ざっていないことを桁数で見る
    expect(body.serverTime).toBeLessThan(1e11);
  });
});

describe('未知の API パス', () => {
  it('404 とエラーフォーマットを返す', async () => {
    const response = await get('/api/nope');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
