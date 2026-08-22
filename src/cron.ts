/**
 * 保持期間の掃除を回す cron。**wrangler.jsonc の triggers.crons と同じ文字列**で
 * なければならない（食い違うと掃除が一度も走らず、しかも何も起きないので気付けない）。
 * ずれていないことは src/index.test.ts で見ている。
 *
 * 02:23 JST。取得が薄い時間帯に置く
 *
 * **エントリポイント（src/index.ts）から export しない。** workerd はエントリの
 * named export を全て entrypoint（関数か ExportedHandler）として扱うので、
 * 文字列を置くと `wrangler dev` が
 * 「Incorrect type for map entry 'RETENTION_CRON'」で起動しなくなる
 */
export const RETENTION_CRON = '23 17 * * *';
