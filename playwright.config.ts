import { defineConfig, devices } from '@playwright/test';

/**
 * E2E はキーバインドの確認が目的なので、API はテスト側でモックして
 * Vite の開発サーバだけを立てる（wrangler と D1 は Vitest 側で見ている）。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // 1 つの dev サーバを全ワーカーで共有しているので、並列度を上げても速くならず、
  // 起動待ち（IndexedDB の読み出し + bootstrap）が詰まって落ちる。CPU 数任せにしない
  workers: 4,
  reporter: 'list',
  use: {
    // retries が 0 なので on-first-retry では何も残らない。落ちた回のトレースを残す
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /pwa\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5173' },
    },
    {
      /**
       * Service Worker は本番ビルドにだけ登録される（web/src/main.ts）。開発サーバでは
       * 動かないので、組み上げた dist を preview で配って当てる。
       * オフライン起動と画像の控えは、ここでしか壊れに気付けない
       */
      name: 'pwa',
      testMatch: /pwa\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
  ],
  webServer: [
    {
      command: 'pnpm -C web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // 組み直してから配る。古い dist に当てると、直したはずの Service Worker が
      // 試されないまま緑になる
      command: 'pnpm build && pnpm -C web preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
