import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// vitest.config.ts が渡すテスト専用のバインディング。
// 本番の Env（worker-configuration.d.ts）には存在しない
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
