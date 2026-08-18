import { authenticate } from '../lib/auth';
import { jsonError, toErrorResponse } from '../lib/errors';
import { bootstrap } from './bootstrap';
import { entries } from './entries';
import { createFeed, refetchFeed, removeFeed, updateFeed } from './feeds';
import { health } from './health';
import { createPin, removePin } from './pins';
import { exportOpml, importOpml } from './opml';
import { read } from './read';
import { sync } from './sync';
import { setEntryUnread } from './unread';

/**
 * /api/* のルーティング。1 エンドポイント 1 ファイルで、ここは対応表だけを持つ。
 *
 * パスに id を含むルートは `:id` で書き、数値だけを受ける。id は必ず
 * Number.isSafeInteger を通す（桁が多いと Number で丸まり、別の行を指しうる）。
 */

type Handler = (request: Request, env: Env, id: number) => Promise<Response>;

/** `${method} ${path}` → ハンドラ。:id は 1 つ以上の数字にだけ一致する */
const ROUTES: Record<string, Handler> = {
  'GET /api/health': (_request, env) => health(env),
  'GET /api/bootstrap': bootstrap,
  'GET /api/entries': entries,
  'GET /api/sync': sync,
  'POST /api/read': read,
  'POST /api/entries/:id/unread': (_request, env, id) => setEntryUnread(env, id, true),
  'DELETE /api/entries/:id/unread': (_request, env, id) => setEntryUnread(env, id, false),
  'POST /api/feeds': createFeed,
  'PATCH /api/feeds/:id': (request, env, id) => updateFeed(request, env, id),
  'DELETE /api/feeds/:id': (_request, env, id) => removeFeed(env, id),
  'POST /api/feeds/:id/fetch': (_request, env, id) => refetchFeed(env, id),
  'POST /api/pins': createPin,
  'DELETE /api/pins/:id': (_request, env, id) => removePin(env, id),
  'GET /api/opml': (_request, env) => exportOpml(env),
  'POST /api/opml': importOpml,
};

/**
 * 認証を通さないパス。health はデプロイと D1 の疎通確認に使うので、
 * Access の設定を壊したときに切り分けができるよう対象外にしておく
 */
const PUBLIC_ROUTES = new Set(['GET /api/health']);

/** ':id' を含むルートだけを、パターンと素の文字列の対で持っておく */
const DYNAMIC_ROUTES = Object.keys(ROUTES)
  .filter((route) => route.includes('/:id'))
  .map((route) => ({
    route,
    pattern: new RegExp(
      `^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/:id', '/(\\d+)')}$`,
    ),
  }));

interface Match {
  route: string;
  handler: Handler;
  id: number;
}

function resolve(method: string, pathname: string): Match | null {
  const route = `${method} ${pathname}`;

  const staticHandler = ROUTES[route];
  // 静的なパスを先に見る。/api/feeds と /api/feeds/:id は前者が勝つ
  if (staticHandler !== undefined) return { route, handler: staticHandler, id: 0 };

  for (const { route: pattern, pattern: matcher } of DYNAMIC_ROUTES) {
    const matched = matcher.exec(route);
    if (matched === null) continue;

    const id = Number(matched[1]);
    // 桁の多い id は Number にすると丸まる。存在しないものとして 404 に落とす
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return { route: pattern, handler: ROUTES[pattern], id };
  }
  return null;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  try {
    const matched = resolve(request.method, pathname);
    if (matched === null) {
      return jsonError('not_found', `${request.method} ${pathname} は存在しない`, 404);
    }
    if (!PUBLIC_ROUTES.has(matched.route)) {
      await authenticate(request, env);
    }
    return await matched.handler(request, env, matched.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}
