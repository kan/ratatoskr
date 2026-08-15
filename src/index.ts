import { handleApi } from './api/router';

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    // /api/* は Worker が処理し、それ以外は Static Assets に委ねる。
    // wrangler.jsonc の not_found_handling: single-page-application により、
    // 未知のパスは index.html にフォールバックする
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, _env, _ctx): Promise<void> {
    // クローラは M1 で実装する（docs/ROADMAP.md）
  },
} satisfies ExportedHandler<Env>;
