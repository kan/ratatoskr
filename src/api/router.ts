import { authenticate } from '../lib/auth';
import { jsonError, toErrorResponse } from '../lib/errors';
import { bootstrap } from './bootstrap';
import { entries } from './entries';
import { health } from './health';
import { read } from './read';
import { sync } from './sync';
import { setEntryUnread } from './unread';

/**
 * /api/* のルーティング。1 エンドポイント 1 ファイルで、ここは対応表だけを持つ。
 * 大半は静的なパスなので表引きで済ませ、id を含むものだけ個別に見る。
 * ルート数が 10 を超えたら本物のパターンマッチに置き換える。
 */

type Handler = (request: Request, env: Env) => Promise<Response>;

/** `${method} ${path}` → ハンドラ */
const ROUTES: Record<string, Handler> = {
  'GET /api/health': (_request, env) => health(env),
  'GET /api/bootstrap': bootstrap,
  'GET /api/entries': entries,
  'GET /api/sync': sync,
  'POST /api/read': read,
};

/**
 * 認証を通さないパス。health はデプロイと D1 の疎通確認に使うので、
 * Access の設定を壊したときに切り分けができるよう対象外にしておく
 */
const PUBLIC_ROUTES = new Set(['GET /api/health']);

/**
 * パスに id を含む唯一のルート。これ 1 本のためにルータを一般化しない。
 * 増えたら（M5 の /api/feeds/:id で増える）表引きに作り替える。
 */
const ENTRY_UNREAD = /^\/api\/entries\/(\d+)\/unread$/;

function resolveEntryUnread(method: string, pathname: string): Handler | undefined {
  const matched = ENTRY_UNREAD.exec(pathname);
  if (matched === null) return undefined;

  const entryId = Number(matched[1]);
  // 桁数の多い id は Number にすると丸まる。存在しない記事として 404 に落とす方が安全
  if (!Number.isSafeInteger(entryId)) return undefined;

  if (method === 'POST') return (_request, env) => setEntryUnread(env, entryId, true);
  if (method === 'DELETE') return (_request, env) => setEntryUnread(env, entryId, false);
  return undefined;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;

  try {
    const handler = ROUTES[route] ?? resolveEntryUnread(request.method, pathname);
    if (handler === undefined) {
      return jsonError('not_found', `${route} は存在しない`, 404);
    }
    if (!PUBLIC_ROUTES.has(route)) {
      await authenticate(request, env);
    }
    return await handler(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}
