import {
  markFetchFailure,
  markFetchSuccess,
  markFetchUnchanged,
  selectCrawlTargets,
  selectCrawlTargetsByIds,
  type CrawlTarget,
} from '../db/feeds';
import { insertEntries, type NewEntry } from '../db/entries';
import { errorMessage } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { fetchFeed } from './fetch';
import { parseFeed } from './parse';
import { sanitizeHtml } from './sanitize';
import {
  backoffAfterFailure,
  intervalAfterNoUpdate,
  intervalAfterUpdate,
  shouldDisable,
} from './schedule';
import type { ParsedItem } from './types';

/**
 * クローラの入口。cron から呼ばれる。
 *
 * 1 回の実行で処理するフィード数は必ず絞る。サブリクエスト上限があるため、
 * LIMIT を外してはいけない（docs/DESIGN.md §5）。
 */

/** 1 回の cron で処理するフィード数 */
const MAX_FEEDS_PER_RUN = 20;
/** 同時に取りに行くフィード数。相手のサーバに配慮して広げない */
const CONCURRENCY = 4;
/** 1 フィードから 1 回に取り込む記事数の上限 */
const MAX_ITEMS_PER_FEED = 100;
/** last_error に入れる長さの上限 */
const MAX_ERROR_LENGTH = 500;

export interface CrawlOptions {
  now?: number;
  limit?: number;
  concurrency?: number;
  /** テストや手動クロールで差し替える */
  fetchImpl?: typeof fetch;
  /** 指定すると next_fetch_at を無視してこのフィードだけを処理する */
  feedIds?: number[];
}

export interface CrawlSummary {
  /** 取りに行ったフィード数 */
  checked: number;
  /** 新着記事があったフィード数 */
  updated: number;
  /** 追加した記事の総数 */
  inserted: number;
  /** 取得・パースに失敗したフィード数 */
  failed: number;
}

export async function crawl(env: Env, options: CrawlOptions = {}): Promise<CrawlSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? CONCURRENCY;

  const targets = options.feedIds
    ? await selectCrawlTargetsByIds(env.DB, options.feedIds)
    : await selectCrawlTargets(env.DB, now, options.limit ?? MAX_FEEDS_PER_RUN);

  const summary: CrawlSummary = { checked: targets.length, updated: 0, inserted: 0, failed: 0 };

  // Promise.allSettled をチャンクに分けて回す。1 本の失敗で他を巻き込まない
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((target) => crawlFeed(env.DB, target, now, fetchImpl)),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        // crawlFeed 内で拾い切れなかった例外。フィードの状態は更新できていないので
        // 記録だけして次回の cron に任せる
        console.error('crawl failed unexpectedly', chunk[index].url, result.reason);
        summary.failed += 1;
        continue;
      }
      if (result.value.failed) summary.failed += 1;
      if (result.value.inserted > 0) summary.updated += 1;
      summary.inserted += result.value.inserted;
    }
  }

  return summary;
}

interface FeedResult {
  inserted: number;
  failed: boolean;
}

async function crawlFeed(
  db: D1Database,
  target: CrawlTarget,
  now: number,
  fetchImpl: typeof fetch,
): Promise<FeedResult> {
  const outcome = await fetchFeed(target, fetchImpl);

  if (outcome.kind === 'error') {
    await recordFailure(db, target, now, outcome.message);
    return { inserted: 0, failed: true };
  }

  if (outcome.kind === 'notModified' || outcome.kind === 'unchanged') {
    const fetchInterval = intervalAfterNoUpdate(target.fetchInterval);
    await markFetchUnchanged(db, {
      id: target.id,
      now,
      nextFetchAt: now + fetchInterval,
      fetchInterval,
    });
    return { inserted: 0, failed: false };
  }

  let parsed;
  try {
    parsed = parseFeed(outcome.body, now);
  } catch (err) {
    await recordFailure(db, target, now, errorMessage(err));
    return { inserted: 0, failed: true };
  }

  // フィードは新しい記事から並べるのが通例。逆順に入れて、古い記事ほど小さい
  // id を持つようにする。id の並びがそのまま読む順序になる（CLAUDE.md 不変条件 1）
  const items = parsed.items.slice(0, MAX_ITEMS_PER_FEED).reverse();
  const baseUrl = parsed.siteUrl ?? target.url;
  const rows = await Promise.all(items.map((item) => toNewEntry(target.id, item, baseUrl)));

  const inserted = await insertEntries(db, rows, now);

  const fetchInterval =
    inserted > 0 ? intervalAfterUpdate() : intervalAfterNoUpdate(target.fetchInterval);
  await markFetchSuccess(db, {
    id: target.id,
    now,
    nextFetchAt: now + fetchInterval,
    fetchInterval,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    contentHash: outcome.contentHash,
    title: parsed.title,
    siteUrl: parsed.siteUrl,
  });

  return { inserted, failed: false };
}

async function toNewEntry(feedId: number, item: ParsedItem, baseUrl: string): Promise<NewEntry> {
  const url = item.url === null ? null : absoluteUrl(item.url, baseUrl);
  return {
    feedId,
    guidHash: await guidHash(item),
    url,
    title: item.title,
    author: item.author,
    // 生のフィード HTML は DB に入れない（CLAUDE.md の不変条件 4）。
    // 本文中の相対 URL の基準には絶対化した記事 URL を使う。item.url をそのまま
    // 渡すと、相対リンクを返すフィードでは基準自体が相対 URL になり、
    // 本文中の href / src が全て落ちる
    body: await sanitizeHtml(item.body, url ?? baseUrl),
    publishedAt: item.publishedAt,
  };
}

/**
 * 同一性判定の材料を選ぶ。guid → link → title + published の優先順
 * （docs/DESIGN.md §3）。どれも無いフィードでも決定的な値になるようにする。
 */
function guidHash(item: ParsedItem): Promise<string> {
  const source = item.guid ?? item.url ?? `${item.title}\n${item.publishedAt ?? ''}`;
  return sha256Hex(source);
}

function absoluteUrl(url: string, baseUrl: string): string | null {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

async function recordFailure(
  db: D1Database,
  target: CrawlTarget,
  now: number,
  message: string,
): Promise<void> {
  const failures = target.consecutiveFailures + 1;
  await markFetchFailure(db, {
    id: target.id,
    now,
    nextFetchAt: now + backoffAfterFailure(failures),
    failures,
    message: message.slice(0, MAX_ERROR_LENGTH),
    disabled: shouldDisable(failures),
  });
}
