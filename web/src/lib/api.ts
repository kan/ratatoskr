import type { ApiErrorBody, BootstrapResponse, EntriesResponse } from '@shared/types';

/**
 * 型付き API クライアント。
 *
 * 本番は Worker と同一オリジンなので常に相対パスで叩く（開発時は Vite の proxy が
 * 8787 に渡す）。認証は Cloudflare Access の cookie が自動で付くので、ここでは
 * 何もしない。
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

type QueryParams = Record<string, string | number | boolean | undefined>;

async function get<T>(path: string, params: QueryParams = {}): Promise<T> {
  const query = new URLSearchParams();
  // 未指定のパラメータは送らない（サーバ側の既定値に任せる）
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query}` : '';

  const response = await fetch(`/api${path}${suffix}`, {
    headers: { accept: 'application/json' },
    // Access の cookie を載せる
    credentials: 'same-origin',
  });

  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return new ApiError(body.error.code, body.error.message, response.status);
  } catch {
    // エラー応答が JSON とは限らない（Access のログイン画面など）
    return new ApiError('unexpected_response', `HTTP ${response.status}`, response.status);
  }
}

export type BootstrapParams = {
  feeds?: number;
  entriesPerFeed?: number;
};

export function getBootstrap(params: BootstrapParams = {}): Promise<BootstrapResponse> {
  return get<BootstrapResponse>('/bootstrap', params);
}

export type EntriesParams = {
  sinceId?: number;
  feedId?: number;
  unreadOnly?: boolean;
  limit?: number;
};

export function getEntries(params: EntriesParams = {}): Promise<EntriesResponse> {
  return get<EntriesResponse>('/entries', params);
}
