import type {
  CreateFeedResponse,
  Entry,
  FeedCandidate as SharedFeedCandidate,
  RecipeSource,
  FeedCandidatesResponse,
  FeedResponse,
  FetchFeedResponse,
  UpdateFeedRequest,
} from '../../shared/types';
import { isRecipeSource, RECIPE_SOURCES } from '../../shared/types';
import { crawl } from '../crawler';
import { discoverFeed } from '../crawler/discover';
import { fetchArticlePage } from '../crawler/fetch';
import { inferRecipe } from '../crawler/infer';
import { titleFromHtml } from '../crawler/page-title';
import { createPoliteFetch } from '../crawler/polite';
import { parseRecipe } from '../crawler/recipe';
import { selectEntries, selectEntriesByIds, selectMaxEntryId } from '../db/entries';
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
  const input = body as {
    url?: unknown;
    rate?: unknown;
    folder?: unknown;
    recipe?: unknown;
    recipeSource?: unknown;
  };

  const url = normalizeUrl(input.url);
  const rate = input.rate === undefined ? 3 : parseRate(input.rate);
  const folder = input.folder === undefined ? '' : parseFolder(input.folder);

  // 取得定義が付いてきたら自動検出はしない（issue #40）
  if (input.recipe !== undefined) {
    const recipe = parseRecipe(input.recipe);
    if (typeof recipe === 'string') return badRequest(`取得定義が正しくない: ${recipe}`);
    const source = parseRecipeSource(input.recipeSource);
    return register(env, url, recipe.title ?? '', rate, folder, {
      json: JSON.stringify(recipe),
      source,
    });
  }

  const found = await discoverFeed(url);
  const { result } = found;
  if (result.kind === 'error') {
    throw new ApiError('fetch_failed', result.message, 502);
  }
  // 上の階層で見つけたものは、フィードそのものでも 1 件でも選ばせる
  // （理由は crawler/discover.ts の Discovery.viaAncestor）
  const choose = (candidates: SharedFeedCandidate[]): Response => {
    const body: FeedCandidatesResponse = { candidates, foundAt: found.pageUrl };
    return json(body, 300);
  };

  if (result.kind === 'feed') {
    if (found.viaAncestor) return choose([{ url: result.url, title: result.title }]);
    return register(env, result.url, result.title, rate, folder);
  }

  if (result.candidates.length === 0) {
    // フィードが無い。貼られたページから取得定義を推定して、候補として見せる（issue #40）。
    // 黙って登録しないのは、推定が外れて別の並び（ナビゲーション）を掴むことがあるため。
    // 取れた見出しを見せて、利用者に確かめさせる
    const inferred = await inferFromPage(env, url);
    if (inferred !== null) return choose([inferred]);
    throw new ApiError('feed_not_found', 'このページからフィードを見つけられない', 404);
  }
  // 候補が複数あるときも、どれを購読するかは決められないので選ばせる
  if (result.candidates.length > 1 || found.viaAncestor) {
    return choose(result.candidates);
  }
  // 候補の title は <link title="..."> で、「Atom」「RSS」のような総称のことが多い。
  // 名前はフィード自身の名乗りに任せる（空で入れると初回クロールが埋める）
  return register(env, result.candidates[0].url, '', rate, folder);
}

/** 推定した候補に添える見出しの数 */
const PREVIEW_TITLES = 5;

/**
 * 貼られたページを取り直して、取得定義を推定する。
 *
 * 検出（discoverFeed）も同じページを取っているが、あちらは `<link>` を拾う走査で
 * 本文を手放している。購読の追加は対話的な操作で、1 回余分に取るのは許容範囲。
 * 記事の一覧のページはフィードではないので robots.txt を見る（issue #39）
 */
async function inferFromPage(env: Env, url: string): Promise<SharedFeedCandidate | null> {
  const now = Math.floor(Date.now() / 1000);
  const polite = createPoliteFetch(fetch, { db: env.DB, now });
  const page = await fetchArticlePage(url, polite.page);
  // 禁じられているのに「フィードが無い」と返すと、理由が分からないまま諦めることになる
  if (page.kind === 'disallowed') {
    throw new ApiError(
      'feed_not_found',
      'このページにフィードが無く、記事の一覧を推定しようとしたが、サイトの robots.txt で取得が禁じられている',
      404,
    );
  }
  if (page.kind !== 'ok') return null;
  const title = (await titleFromHtml(page.html)) ?? '';
  const inferred = await inferRecipe(page.html, url, title, env.AI, now);
  if (inferred === null) return null;
  return {
    url,
    title: title === '' ? null : title,
    recipe: inferred.recipe,
    recipeSource: inferred.source,
    preview: inferred.feed.items.slice(0, PREVIEW_TITLES).map((item) => item.title),
  };
}

function parseRecipeSource(value: unknown): RecipeSource {
  if (value === undefined) return 'manual';
  if (isRecipeSource(value)) return value;
  return badRequest(`recipeSource は ${RECIPE_SOURCES.join(' / ')} のいずれか`);
}

async function register(
  env: Env,
  feedUrl: string,
  title: string,
  rate: number,
  folder: string,
  recipe?: { json: string; source: RecipeSource },
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const id = await insertFeed(
    env.DB,
    {
      url: feedUrl,
      siteUrl: null,
      title,
      rate,
      folder,
      ...(recipe === undefined ? {} : { recipe }),
    },
    now,
  );
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
    ...(input.disabled === undefined ? {} : { disabled: parseBoolean(input.disabled, 'disabled') }),
    ...(input.fullText === undefined ? {} : { fullText: parseBoolean(input.fullText, 'fullText') }),
    ...(input.nsfw === undefined ? {} : { nsfw: parseBoolean(input.nsfw, 'nsfw') }),
    ...(input.translate === undefined
      ? {}
      : { translate: parseBoolean(input.translate, 'translate') }),
    ...(input.transcribe === undefined
      ? {}
      : { transcribe: parseBoolean(input.transcribe, 'transcribe') }),
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

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') badRequest(`${name} は真偽値で指定する`);
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

  const summary = await crawl(env, { feedIds: [id] });

  // 増えた記事に加えて、全文取得（M7）で本文が差し替わった記事も返す。
  // 既にクライアントが持っている記事なので、sinceId の差分には出てこない。
  // 全文取得を入れた直後に手持ちの未読が要約のまま残るのを防ぐ
  const [feed, added, refreshed] = await Promise.all([
    selectFeedById(env.DB, id),
    selectEntries(env.DB, {
      sinceId: before,
      feedId: id,
      unreadOnly: true,
      limit: INITIAL_ENTRIES,
    }),
    selectEntriesByIds(env.DB, summary.filledEntryIds),
  ]);
  if (feed === null) throw new ApiError('not_found', `フィード ${id} は存在しない`, 404);

  const body: FetchFeedResponse = { feed, entries: mergeById(added, refreshed) };
  return json(body);
}

/** 新しく入った記事と本文が差し替わった記事。両方に出てくるものは 1 件にまとめる */
function mergeById(added: Entry[], refreshed: Entry[]): Entry[] {
  const byId = new Map(added.map((entry) => [entry.id, entry]));
  for (const entry of refreshed) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
