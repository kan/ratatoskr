import { handleApi } from './api/router';
import { crawl } from './crawler';
import { purgeExpiredEntries } from './retention';

/**
 * 保持期間の掃除を回す cron。**wrangler.jsonc の triggers.crons と同じ文字列**で
 * なければならない（食い違うと掃除が一度も走らず、しかも何も起きないので気付けない）。
 * ずれていないことは src/index.test.ts で見ている。
 *
 * 02:23 JST。取得が薄い時間帯に置く
 */
export const RETENTION_CRON = '23 17 * * *';

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

  async scheduled(event, env, _ctx): Promise<void> {
    // 例外は握りつぶさず投げ直す。cron の失敗として観測できるようにするため
    if (event.cron === RETENTION_CRON) {
      const summary = await purgeExpiredEntries(env);
      console.log('purge', JSON.stringify(summary));
      return;
    }

    const { filledEntryIds, ...counts } = await crawl(env);
    // filledEntryIds は記事の id をそのまま持つので、件数だけを残す。
    // cron のログは毎回出るものなので、追える形で短くしておく
    console.log('crawl', JSON.stringify({ ...counts, filled: filledEntryIds.length }));
  },
} satisfies ExportedHandler<Env>;
