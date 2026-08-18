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
    baseURL: 'http://localhost:5173',
    // retries が 0 なので on-first-retry では何も残らない。落ちた回のトレースを残す
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm -C web dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
