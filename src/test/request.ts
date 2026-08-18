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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  origin = 'http://localhost',
): Promise<Response> {
  return apiRaw(method, path, {
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    origin,
  });
}

export interface RawOptions {
  headers?: Record<string, string>;
  body?: BodyInit;
  origin?: string;
}

/** JSON 以外のボディ（OPML の生テキストや multipart）を投げるとき用 */
export async function apiRaw(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RawOptions = {},
): Promise<Response> {
  const request = new IncomingRequest(`${options.origin ?? 'http://localhost'}${path}`, {
    method,
    headers: options.headers,
    body: options.body,
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
