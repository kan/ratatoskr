import { handleApi } from './api/router';
import { crawl } from './crawler';
import { RETENTION_CRON } from './cron';
import { ingestMail } from './mail/ingest';
import { transcribePending } from './crawler/transcribe';
import { purgeExpiredEntries } from './retention';

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

    // Podcast の文字起こし（issue #46）。フィードの取得とは別の仕事として毎回進める
    // （src/crawler/transcribe.ts）
    const transcribed = await transcribePending(env);
    if (transcribed.length > 0) console.log('transcribe', JSON.stringify({ done: transcribed }));
  },

  // メールマガジンの取り込み（issue #41）。Cloudflare Email Routing でこの Worker に
  // 回したメールが届く
  async email(message, env, _ctx): Promise<void> {
    const outcome = await ingestMail(
      env,
      { to: message.to, raw: message.raw, rawSize: message.rawSize },
      Math.floor(Date.now() / 1000),
    );
    // 断ったメールは送り手に戻す。転送元（Gmail）に戻るので、設定の誤りに気付ける
    if (outcome.kind === 'rejected') message.setReject(outcome.reason);
    console.log('email', JSON.stringify(outcome));
  },
} satisfies ExportedHandler<Env>;
