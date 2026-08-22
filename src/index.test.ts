import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from './index';
import { RETENTION_CRON } from './cron';
import wranglerConfig from '../wrangler.jsonc?raw';
import { getEntryRows, seedEntry, seedFeed, setReadSeq } from './test/seed';

/**
 * cron の振り分け（M9）。5 分毎の取得と、1 日 1 回の保持期間の掃除を
 * event.cron で分けている。
 */

const NOW = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
/** 保持期間（30 日）の外 */
const OLD = NOW - 40 * 86_400;

/** 既読で保持期間を過ぎた記事を 1 件だけ持つフィードを作る */
async function seedExpired(): Promise<number> {
  const feedId = await seedFeed(env.DB, 'https://example.com/feed.xml', {
    // 取得の cron に拾われないよう、次の取得は先の時刻にしておく
    nextFetchAt: NOW + 86_400,
  });
  const entryId = await seedEntry(env.DB, feedId, { storedAt: OLD });
  await setReadSeq(env.DB, feedId, entryId);
  return feedId;
}

async function runScheduled(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  const controller = { cron, scheduledTime: Date.now(), noRetry: () => undefined };
  await worker.scheduled?.(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('scheduled', () => {
  it('掃除の cron では保持期間を過ぎた記事を消す', async () => {
    const feedId = await seedExpired();

    await runScheduled(RETENTION_CRON);

    expect(await getEntryRows(env.DB, feedId)).toEqual([]);
  });

  it('取得の cron では記事を消さない', async () => {
    const feedId = await seedExpired();

    // 5 分毎に掃除まで走ると、記事が入るまでの時間にただ積み上がる
    await runScheduled('*/5 * * * *');

    expect(await getEntryRows(env.DB, feedId)).toHaveLength(1);
  });

  it('掃除の cron が wrangler.jsonc に登録されている', () => {
    // **文字列が食い違うと掃除は一度も走らない。** しかも何も起きないだけなので、
    // 動かしていて気付ける類の壊れ方ではない
    const crons = cronsOf(wranglerConfig);
    expect(crons).toContain(RETENTION_CRON);
  });
});

/** wrangler.jsonc の triggers.crons を読む。行頭コメント（// …）だけを落とせば JSON */
function cronsOf(source: string): string[] {
  const json = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const config = JSON.parse(json) as { triggers?: { crons?: string[] } };
  return config.triggers?.crons ?? [];
}
