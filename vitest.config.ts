import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Worker のユニットテストは実際の workerd 上で走らせる。
// バインディングは wrangler.jsonc から取り、D1 は miniflare がテスト用に
// メモリ上へ作るので、ローカル・本番の D1 は汚さない。
//
// web 側のストアは workerd に載せる意味がないので、素の Node で別プロジェクトとして
// 走らせる。エイリアス（@ / @shared）は web/vite.config.ts の定義を引き継ぐ。

// テスト用 D1 は空で立ち上がるため、migrations/ をバインディング経由で渡し、
// setupFiles の中で流し込む（src/test/setup.ts）
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // Workers AI（M7 の全文取得）は必ずリモートに繋ぎに行くバインディングで、
            // 有効にしたままだとテストが Cloudflare への接続を張り、認証が要るうえに
            // 終了時にプロセスが残る。テストは AI を差し替えて呼ぶ（choose.test.ts）ので、
            // ここでは繋がせない
            remoteBindings: false,
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // 認証のバイパスはテストでも明示的に立てる。.dev.vars の有無に依存させない
                ACCESS_DEV_BYPASS: 'true',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: './web/vite.config.ts',
        test: {
          name: 'web',
          include: ['web/src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
