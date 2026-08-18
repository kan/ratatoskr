import type {
  ApiErrorBody,
  BootstrapResponse,
  CreateFeedRequest,
  CreateFeedResponse,
  EntriesResponse,
  FeedCandidatesResponse,
  FeedResponse,
  FetchFeedResponse,
  OpmlImportResponse,
  ReadMark,
  ReadRequest,
  ReadResponse,
  UpdateFeedRequest,
} from '@shared/types';

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

/**
 * 書き込み。全て冪等なので、失敗したら同じものをそのまま再送してよい（DESIGN.md §6）。
 *
 * keepalive を付けると、タブが閉じられた後もブラウザが送信を続けてくれる。
 * outbox の吐き出しは離脱時に走ることがあるので既定で付ける。
 */
async function send<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  // FormData は境界文字列込みの Content-Type をブラウザに決めさせる。自分で付けない
  const isForm = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    credentials: 'same-origin',
    // 離脱時にも送り切るための keepalive。ただしボディは 64KB までなので、
    // OPML のような大きい本文には付けない
    keepalive: !isForm,
  });

  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** 既読ウォーターマークをまとめて送る */
export function postRead(marks: ReadMark[]): Promise<ReadResponse> {
  const body: ReadRequest = { marks };
  return send<ReadResponse>('POST', '/read', body);
}

/** 個別の記事を未読に戻す / 戻したものを既読にする */
export function sendEntryUnread(entryId: number, unread: boolean): Promise<ReadResponse> {
  const path = `/entries/${entryId}/unread`;
  return unread ? send<ReadResponse>('POST', path) : send<ReadResponse>('DELETE', path);
}

/**
 * ページ破棄の直前に既読を送る。fetch は破棄と競合して取り消されることがあるので、
 * ブラウザに送信を委ねられる sendBeacon を使う。
 *
 * 応答は読めない。届いたかどうかは分からないので、キューからは消さずに次回の起動で
 * 再送する（冪等なので二重に届いても害が無い）。
 */
export function beaconRead(marks: ReadMark[]): boolean {
  if (typeof navigator.sendBeacon !== 'function') return false;
  const body: ReadRequest = { marks };
  // Content-Type は Blob の type がそのまま載る
  const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
  return navigator.sendBeacon('/api/read', blob);
}

/**
 * 購読の追加。フィードの検出も初回クロールもサーバ側でしかできないので、
 * ここだけは応答を待つ（購読管理画面は普通のフォーム UI。docs/ROADMAP.md M5）。
 *
 * フィードが複数見つかった場合はサーバが 300 を返す。エラーではなく
 * 「どれにするか決まらなかった」なので、候補を添えて呼び出し側に返す。
 */
export type CreateFeedResult =
  | { kind: 'created'; body: CreateFeedResponse }
  | { kind: 'candidates'; candidates: FeedCandidatesResponse['candidates'] };

export async function createFeed(params: CreateFeedRequest): Promise<CreateFeedResult> {
  const response = await fetch('/api/feeds', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'same-origin',
  });

  if (response.status === 300) {
    const body = (await response.json()) as FeedCandidatesResponse;
    return { kind: 'candidates', candidates: body.candidates };
  }
  if (!response.ok) throw await toApiError(response);
  return { kind: 'created', body: (await response.json()) as CreateFeedResponse };
}

export function updateFeed(id: number, params: UpdateFeedRequest): Promise<FeedResponse> {
  return send<FeedResponse>('PATCH', `/feeds/${id}`, params);
}

export function deleteFeed(id: number): Promise<{ deleted: number }> {
  return send<{ deleted: number }>('DELETE', `/feeds/${id}`);
}

/** 手動更新（r キー）。next_fetch_at を無視して取りに行く */
export function refetchFeed(id: number): Promise<FetchFeedResponse> {
  return send<FetchFeedResponse>('POST', `/feeds/${id}/fetch`);
}

export function importOpml(file: File): Promise<OpmlImportResponse> {
  const form = new FormData();
  form.set('file', file);
  return send<OpmlImportResponse>('POST', '/opml', form);
}
