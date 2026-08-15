import { jsonError, toErrorResponse } from '../lib/errors';
import { health } from './health';

/**
 * /api/* のルーティング。1 エンドポイント 1 ファイルで、ここは対応表だけを持つ。
 * ルート数が 10 を超えたらパターンマッチに置き換える。それまでは素の分岐で足りる。
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  try {
    if (pathname === '/api/health' && method === 'GET') {
      return await health(env);
    }
    return jsonError('not_found', `${method} ${pathname} は存在しない`, 404);
  } catch (err) {
    return toErrorResponse(err);
  }
}
