import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach } from 'vitest';
import { resetDb } from './seed';

// テスト用の D1 は空で立ち上がるので、実際の migrations/ をそのまま適用する。
// スキーマの取り違えを防ぐため、テスト専用の CREATE TABLE は書かない
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// D1 はテスト間で共有され、テストごとの巻き戻しは無い。各ファイルで書き忘れると
// そのファイルだけ前のテストの残留データを引きずるので、ここで一律に白紙化する
beforeEach(async () => {
  await resetDb(env.DB);
});
