import { handleApi } from './api/router';
import { crawl } from './crawler';

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

  async scheduled(_event, env, _ctx): Promise<void> {
    // 例外は握りつぶさず投げ直す。cron の失敗として観測できるようにするため
    const summary = await crawl(env);
    console.log('crawl', JSON.stringify(summary));
  },
} satisfies ExportedHandler<Env>;
