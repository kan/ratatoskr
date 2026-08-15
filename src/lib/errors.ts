import type { ApiErrorBody } from '../../shared/types';

/**
 * API から投げる想定内のエラー。ハンドラの外側（src/index.ts）で
 * JSON レスポンスに変換する。想定外の例外は 500 にまとめる。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // API レスポンスは常にプライベート。Access の後ろとはいえ中間キャッシュに載せない
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function jsonError(code: string, message: string, status: number): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, status);
}

/** 想定内・想定外を問わず、例外を統一フォーマットのレスポンスに落とす */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonError(err.code, err.message, err.status);
  }
  // 握りつぶさない。詳細はログに出し、クライアントには漏らさない
  console.error('unhandled error in api handler', err);
  return jsonError('internal_error', 'サーバ内部エラー', 500);
}
