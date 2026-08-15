import type { HealthResponse } from '../../shared/types';
import { SCHEMA_VERSION } from '../../shared/types';
import { json } from '../lib/errors';
import { ping } from '../db/health';

/**
 * GET /api/health
 *
 * デプロイと D1 バインディングの疎通確認用。認証の対象外にしておくと
 * Access の設定を壊したときに切り分けができる。
 */
export async function health(env: Env): Promise<Response> {
  const dbOk = await ping(env.DB);
  const body: HealthResponse = {
    ok: dbOk,
    serverTime: Math.floor(Date.now() / 1000),
    schemaVersion: SCHEMA_VERSION,
    db: dbOk ? 'ok' : 'error',
  };
  return json(body, dbOk ? 200 : 503);
}
