import type { BootstrapResponse } from '../../shared/types';
import { SCHEMA_VERSION } from '../../shared/types';
import { selectFeeds } from '../db/feeds';
import { selectMaxEntryId, selectUnreadEntriesByFeed } from '../db/entries';
import { selectPins } from '../db/pins';
import { json } from '../lib/errors';
import { intParam } from '../lib/params';

/**
 * GET /api/bootstrap
 *
 * 起動時のラウンドトリップを 1 回にするためのエンドポイント。
 * 残りの記事は背景で GET /api/entries を回して取る（docs/DESIGN.md §6）。
 */

const DEFAULT_FEEDS = 5;
const DEFAULT_ENTRIES_PER_FEED = 50;

export async function bootstrap(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedCount = intParam(url, 'feeds', { default: DEFAULT_FEEDS, min: 0, max: 200 });
  const entriesPerFeed = intParam(url, 'entriesPerFeed', {
    default: DEFAULT_ENTRIES_PER_FEED,
    min: 0,
    max: 500,
  });

  // 起動時のレイテンシがそのまま体感速度になるので、依存の無いものは待ち合わせない。
  // 記事の抽出だけは「どのフィードを同梱するか」に依存するので feeds の後に回す
  const [feeds, pins, maxEntryId] = await Promise.all([
    selectFeeds(env.DB),
    selectPins(env.DB),
    selectMaxEntryId(env.DB),
  ]);

  // feeds の並び（レート降順 → 未読数降順）が読む順序なので、その先頭から同梱する。
  // 未読が無いフィードを含めても記事は 0 件なので、素直に先頭から取ればよい
  const inlineFeedIds = feeds.slice(0, feedCount).map((feed) => feed.id);
  const entries = await selectUnreadEntriesByFeed(env.DB, inlineFeedIds, entriesPerFeed);

  const body: BootstrapResponse = {
    serverTime: Math.floor(Date.now() / 1000),
    schemaVersion: SCHEMA_VERSION,
    feeds,
    entries,
    pins,
    maxEntryId,
  };
  return json(body);
}
