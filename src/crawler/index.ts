import type { FeedErrorKind } from '../../shared/types';
import {
  markFetchFailure,
  markFetchSuccess,
  markFetchUnchanged,
  markFullTextSuggested,
  selectCrawlTargets,
  selectCrawlTargetsByIds,
  type CrawlTarget,
} from '../db/feeds';
import { insertEntries, selectKnownGuidHashes, type NewEntry } from '../db/entries';
import { errorMessage } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { mayHaveTweetEmbed, resolveTweetEmbeds } from './embed';
import { fetchFeed, type FetchBudget } from './fetch';
import { fillFullText, looksSummaryOnly, type FullTextOptions } from './fulltext';
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

/**
 * 1 回の cron で取りに行く記事ページの上限（全フィード合わせて）。
 *
 * フィード本体を 20 本取ったうえに積み上がるので、サブリクエスト上限に収まる幅に
 * 抑える（docs/DESIGN.md §5）。全文取得を入れたフィードは数本のはずなので、
 * 定常状態ではここに当たらない
 */
const MAX_FULL_TEXT_PER_RUN = 20;

export interface CrawlOptions {
  now?: number;
  limit?: number;
  concurrency?: number;
  /** テストや手動クロールで差し替える */
  fetchImpl?: typeof fetch;
  /** 指定すると next_fetch_at を無視してこのフィードだけを処理する */
  feedIds?: number[];
  /** 記事ページのどこが本文かを判定させる（M7）。無ければ点数だけで決める */
  ai?: Ai;
  /** 記事ページを取りに行ける数の上限。既定は MAX_FULL_TEXT_PER_RUN */
  fullTextLimit?: number;
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
  /**
   * 記事ページから本文を埋めた記事の id（M7）。
   *
   * 件数ではなく id を返すのは、手動更新（POST /api/feeds/:id/fetch）が
   * 「本文が差し替わった記事」をクライアントに返すため。既にクライアントが
   * 持っている記事なので、id が無いと差分として取り出しようがない
   */
  filledEntryIds: number[];
}

export async function crawl(env: Env, options: CrawlOptions = {}): Promise<CrawlSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? CONCURRENCY;

  const targets = options.feedIds
    ? await selectCrawlTargetsByIds(env.DB, options.feedIds)
    : await selectCrawlTargets(env.DB, now, options.limit ?? MAX_FEEDS_PER_RUN);

  const summary: CrawlSummary = {
    checked: targets.length,
    updated: 0,
    inserted: 0,
    failed: 0,
    filledEntryIds: [],
  };
  // フィードをまたいで減っていく。1 本のフィードが使い切ることがある
  const budget: FetchBudget = { remaining: options.fullTextLimit ?? MAX_FULL_TEXT_PER_RUN };

  // Promise.allSettled をチャンクに分けて回す。1 本の失敗で他を巻き込まない
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((target) =>
        crawlFeed(env.DB, target, now, { fetchImpl, ai: options.ai ?? env.AI, budget }),
      ),
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
      summary.filledEntryIds.push(...result.value.filled);
    }
  }

  return summary;
}

interface FeedResult {
  inserted: number;
  failed: boolean;
  /** 記事ページから本文を埋めた記事の id（M7） */
  filled: number[];
}

async function crawlFeed(
  db: D1Database,
  target: CrawlTarget,
  now: number,
  options: FullTextOptions,
): Promise<FeedResult> {
  const outcome = await fetchFeed(target, options.fetchImpl);

  if (outcome.kind === 'error') {
    await recordFailure(db, target, now, outcome.message, outcome.reason);
    return { inserted: 0, failed: true, filled: [] };
  }

  if (outcome.kind === 'notModified' || outcome.kind === 'unchanged') {
    const fetchInterval = intervalAfterNoUpdate(target.fetchInterval);
    await markFetchUnchanged(db, {
      id: target.id,
      now,
      nextFetchAt: now + fetchInterval,
      fetchInterval,
    });
    // 新着が無くても、まだ全文の入っていない未読は埋める。設定を入れた直後に
    // 手持ちの未読が置き去りになるのを防ぐ
    const { filled } = await fillFullText(db, target, options);
    return { inserted: 0, failed: false, filled };
  }

  let parsed;
  try {
    parsed = parseFeed(outcome.body, now);
  } catch (err) {
    // 取れてはいるがフィードではない。URL の付け替えでしか直らないので分けて記録する
    await recordFailure(db, target, now, errorMessage(err), 'not_a_feed');
    return { inserted: 0, failed: true, filled: [] };
  }

  // フィードは新しい記事から並べるのが通例。逆順に入れて、古い記事ほど小さい
  // id を持つようにする。id の並びがそのまま読む順序になる（CLAUDE.md 不変条件 1）
  const items = parsed.items.slice(0, MAX_ITEMS_PER_FEED).reverse();
  const baseUrl = parsed.siteUrl ?? target.url;
  const rows = await Promise.all(items.map((item) => toNewEntry(target.id, item, baseUrl)));

  // 埋め込みを埋める前に測る。埋めた分だけ本文が伸びるので、後で測ると
  // 要約しか配信していないフィードを取りこぼす
  const summaryOnly = !target.fullText && looksSummaryOnly(rows);

  await resolveEmbedsInNewEntries(db, target.id, rows, options);
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

  // 要約しか配信していないなら、購読管理画面で全文取得を勧める。
  // 勧めるだけで取りには行かない。相手のサーバに記事の数だけ取りに行く動作なので、
  // 始めるかどうかはユーザが決める（migrations/0003_full_text.sql）
  if (summaryOnly) await markFullTextSuggested(db, target.id);

  const { filled } = await fillFullText(db, target, options);
  return { inserted, failed: false, filled };
}

/**
 * フィードが配信した本文に埋め込まれた X のポストを、読める形に直す（M7）。
 *
 * **まだ取り込んでいない記事だけを対象にする。** フィードは更新のたびに全件を
 * 配り直すので、既知の記事まで対象にすると同じポストを何度も問い合わせることになる。
 * 埋め込みを含む記事はごく一部なので、文字列で足切りしてから DB を引く。
 */
async function resolveEmbedsInNewEntries(
  db: D1Database,
  feedId: number,
  rows: NewEntry[],
  options: FullTextOptions,
): Promise<void> {
  const candidates = rows.filter((row) => mayHaveTweetEmbed(row.body));
  if (candidates.length === 0) return;

  const known = await selectKnownGuidHashes(
    db,
    feedId,
    candidates.map((row) => row.guidHash),
  );
  for (const row of candidates) {
    if (known.has(row.guidHash)) continue;
    row.body = await resolveTweetEmbeds(row.body, options);
  }
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
  reason: FeedErrorKind,
): Promise<void> {
  const failures = target.consecutiveFailures + 1;
  await markFetchFailure(db, {
    id: target.id,
    now,
    nextFetchAt: now + backoffAfterFailure(failures),
    failures,
    message: message.slice(0, MAX_ERROR_LENGTH),
    reason,
    disabled: shouldDisable(failures),
  });
}
