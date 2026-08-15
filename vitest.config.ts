import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Worker のユニットテストは実際の workerd 上で走らせる。
// バインディングは wrangler.jsonc から取り、D1 は miniflare がテスト用に
// メモリ上へ作るので、ローカル・本番の D1 は汚さない。
// web 側のユニットテストは M3 でストアを書くときに別プロジェクトとして足す。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
