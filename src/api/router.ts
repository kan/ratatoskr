import { authenticate } from '../lib/auth';
import { jsonError, toErrorResponse } from '../lib/errors';
import { bootstrap } from './bootstrap';
import { entries } from './entries';
import { health } from './health';
import { sync } from './sync';

/**
 * /api/* のルーティング。1 エンドポイント 1 ファイルで、ここは対応表だけを持つ。
 * ルート数が 10 を超えたらパターンマッチに置き換える。それまでは素の分岐で足りる。
 */

type Handler = (request: Request, env: Env) => Promise<Response>;

/** `${method} ${path}` → ハンドラ */
const ROUTES: Record<string, Handler> = {
  'GET /api/health': (_request, env) => health(env),
  'GET /api/bootstrap': bootstrap,
  'GET /api/entries': entries,
  'GET /api/sync': sync,
};

/**
 * 認証を通さないパス。health はデプロイと D1 の疎通確認に使うので、
 * Access の設定を壊したときに切り分けができるよう対象外にしておく
 */
const PUBLIC_ROUTES = new Set(['GET /api/health']);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;

  try {
    const handler = ROUTES[route];
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
