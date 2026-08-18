import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../index';

// Worker の fetch は IncomingRequest（cf プロパティ付き）を受け取るため、
// テストからはこの別名で生成する（Cloudflare 公式ドキュメントの定石）
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Worker に 1 リクエスト投げる。既定のオリジンは localhost で、認証はバイパスされる
 * （vitest.config.ts で ACCESS_DEV_BYPASS を立てている）。
 * 本番相当のオリジンを渡すとバイパスが効かず 401 になる。
 */
export async function apiSend(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  origin = 'http://localhost',
): Promise<Response> {
  const request = new IncomingRequest(`${origin}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function apiGet(path: string, origin = 'http://localhost'): Promise<Response> {
  return apiSend('GET', path, undefined, origin);
}

export async function apiJson<T>(path: string): Promise<T> {
  const response = await apiGet(path);
  if (response.status !== 200) {
    throw new Error(`GET ${path} が ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
