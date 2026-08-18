import type {
  CreateFeedResponse,
  FeedCandidatesResponse,
  FeedResponse,
  FetchFeedResponse,
  UpdateFeedRequest,
} from '../../shared/types';
import { crawl } from '../crawler';
import { discoverFeed } from '../crawler/discover';
import { selectEntries, selectMaxEntryId } from '../db/entries';
import { deleteFeed, insertFeed, selectFeedById, updateFeedSettings } from '../db/feeds';
import { badRequest, readJsonBody } from '../lib/body';
import { ApiError, json } from '../lib/errors';

/**
 * 購読の追加・更新・削除・手動取得（docs/API.md「フィード管理」）。
 *
 * 追加だけは outbox を通さず同期的に行う。フィードの検出も初回クロールも
 * サーバでしかできず、結果（候補の提示、取れた記事）をその場で見せる必要がある。
 * 読んでいる最中に押されるレート変更は outbox 経由（CLAUDE.md の不変条件 3）。
 */

/** 登録直後に返す記事数の上限。多すぎても最初の画面には出し切れない */
const INITIAL_ENTRIES = 50;

function parseRate(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
    badRequest('rate は 1 以上 5 以下の整数で指定する');
  }
  return value as number;
}

function parseFolder(value: unknown): string {
  if (typeof value !== 'string') badRequest('folder は文字列で指定する');
  return (value as string).trim();
}

/**
 * ユーザが貼り付ける URL。スキームの省略（example.com）は補う。
 * http / https 以外は弾く（file: や data: を取りに行かせない）。
 */
function normalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') badRequest('url は必須');
  const text = (raw as string).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return badRequest('url が URL として読めない');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    badRequest('url は http か https で指定する');
  }
  return url.href;
}

export async function createFeed(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const input = body as { url?: unknown; rate?: unknown; folder?: unknown };

  const url = normalizeUrl(input.url);
  const rate = input.rate === undefined ? 3 : parseRate(input.rate);
  const folder = input.folder === undefined ? '' : parseFolder(input.folder);

  const found = await discoverFeed(url);
  if (found.kind === 'error') {
    throw new ApiError('fetch_failed', found.message, 502);
  }
  if (found.kind === 'candidates') {
    if (found.candidates.length === 0) {
      throw new ApiError('feed_not_found', 'このページからフィードを見つけられない', 404);
    }
    if (found.candidates.length > 1) {
      // どれを購読するかは決められない。候補を返してユーザに選ばせる
      const body: FeedCandidatesResponse = { candidates: found.candidates };
      return json(body, 300);
    }
    // 候補の title は <link title="..."> で、「Atom」「RSS」のような総称のことが多い。
    // 名前はフィード自身の名乗りに任せる（空で入れると初回クロールが埋める）
    return register(env, found.candidates[0].url, '', rate, folder);
  }
  return register(env, found.url, found.title, rate, folder);
}

async function register(
  env: Env,
  feedUrl: string,
  title: string,
  rate: number,
  folder: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const id = await insertFeed(env.DB, { url: feedUrl, siteUrl: null, title, rate, folder }, now);
  if (id === null) {
    throw new ApiError('already_subscribed', 'このフィードは既に購読している', 409);
  }

  // 登録直後に読めるよう、ここだけは同期的にクロールする（docs/API.md）
  await crawl(env, { feedIds: [id], now });

  // フィードと記事は互いに依存しない。往復を重ねない
  const [feed, entries] = await Promise.all([
    selectFeedById(env.DB, id),
    selectEntries(env.DB, { sinceId: 0, feedId: id, unreadOnly: true, limit: INITIAL_ENTRIES }),
  ]);
  if (feed === null) throw new ApiError('internal_error', '登録したフィードを読み出せない', 500);

  const body: CreateFeedResponse = { feed, entries };
  return json(body, 201);
}

export async function updateFeed(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const input = body as UpdateFeedRequest;

  const settings = {
    ...(input.rate === undefined ? {} : { rate: parseRate(input.rate) }),
    ...(input.folder === undefined ? {} : { folder: parseFolder(input.folder) }),
    ...(input.title === undefined ? {} : { title: parseTitle(input.title) }),
    ...(input.disabled === undefined ? {} : { disabled: parseDisabled(input.disabled) }),
  };

  if (!(await updateFeedSettings(env.DB, id, settings))) {
    throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);
  }
  const feed = await selectFeedById(env.DB, id);
  if (feed === null) throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);

  const responseBody: FeedResponse = { feed };
  return json(responseBody);
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') badRequest('title は文字列で指定する');
  const title = (value as string).trim();
  if (title === '') badRequest('title は空にできない');
  return title;
}

function parseDisabled(value: unknown): boolean {
  if (typeof value !== 'boolean') badRequest('disabled は真偽値で指定する');
  return value as boolean;
}

export async function removeFeed(env: Env, id: number): Promise<Response> {
  if (!(await deleteFeed(env.DB, id))) {
    throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);
  }
  return json({ deleted: id });
}

/**
 * 手動での即時クロール（r キー）。next_fetch_at を無視して取りに行く。
 * 増えた記事だけを返したいので、クロール前の最大 id を控えてから走らせる。
 */
export async function refetchFeed(env: Env, id: number): Promise<Response> {
  // 存在確認と「取得前の最大 id」は互いに依存しない。まとめて引く
  const [current, before] = await Promise.all([
    selectFeedById(env.DB, id),
    selectMaxEntryId(env.DB),
  ]);
  if (current === null) throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);

  await crawl(env, { feedIds: [id] });

  const [feed, entries] = await Promise.all([
    selectFeedById(env.DB, id),
    selectEntries(env.DB, {
      sinceId: before,
      feedId: id,
      unreadOnly: true,
      limit: INITIAL_ENTRIES,
    }),
  ]);
  if (feed === null) throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);

  const body: FetchFeedResponse = { feed, entries };
  return json(body);
}
