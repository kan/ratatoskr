import { ApiError } from './errors';

/**
 * リクエストボディの読み取り。クエリパラメータ（lib/params.ts）と同じく、
 * 外から来た値はここで形を確かめてから使う。
 */

/**
 * JSON ボディを unknown として読む。中身の検証は各ハンドラの型ガードが行う。
 *
 * Content-Type は緩く見る。sendBeacon は Blob の type がそのまま載るので
 * charset 付きで届くことがあり、完全一致で弾くと pagehide の送信だけが落ちる。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError('bad_request', 'Content-Type は application/json で送る', 400);
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError('bad_request', 'ボディが JSON として読めない', 400);
  }
}

/** 型ガードで弾いた値を 400 にするための共通の投げ方 */
export function badRequest(message: string): never {
  throw new ApiError('bad_request', message, 400);
}
