import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

// テスト用の D1 は空で立ち上がるので、実際の migrations/ をそのまま適用する。
// スキーマの取り違えを防ぐため、テスト専用の CREATE TABLE は書かない
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
