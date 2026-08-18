import type { Page } from '@playwright/test';
import type {
  BootstrapResponse,
  CreateFeedResponse,
  EntriesResponse,
  Entry,
  Feed,
  FeedResponse,
  FetchFeedResponse,
  ReadMark,
  ReadRequest,
  ReadResponse,
  UpdateFeedRequest,
} from '../shared/types';
import { HELP_SEEN_KEY } from '../web/src/lib/prefs';

/**
 * E2E は API をモックして UI だけを対象にする。
 * キーバインドの挙動を見るのが目的で、D1 やクローラの正しさは Vitest 側で見ている。
 */

function feed(id: number, title: string, rate: number, unreadCount: number): Feed {
  return {
    id,
    url: `https://example.com/${id}/feed`,
    siteUrl: `https://example.com/${id}/`,
    title,
    iconUrl: null,
    rate,
    folder: '',
    readSeq: 0,
    unreadCount,
    lastFetchedAt: 1786000000,
    lastError: null,
    disabled: false,
  };
}

function entry(id: number, feedId: number, title: string, body: string): Entry {
  return {
    id,
    feedId,
    url: `https://example.com/${feedId}/entries/${id}`,
    title,
    author: 'kan',
    body,
    publishedAt: 1786000000,
    storedAt: 1786000000,
  };
}

const SHORT = '<p>短い本文</p>';
// スクロールが発生する長さ。Space の境界挙動を試すために使う
const LONG = '<p>長い本文</p>'.repeat(400);

/**
 * フィード 3 本。
 *   1: ★5 未読 2（1 件目が長文）
 *   2: ★3 未読 1
 *   3: ★1 未読 0 … s / a で飛ばされることの確認用
 */
export const FEEDS: Feed[] = [
  feed(1, '朝刊', 5, 2),
  feed(2, '夕刊', 3, 1),
  feed(3, '既読済み', 1, 0),
];

export const ENTRIES: Entry[] = [
  entry(11, 1, '朝刊の 1 本目', LONG),
  entry(12, 1, '朝刊の 2 本目', SHORT),
  entry(21, 2, '夕刊の 1 本目', SHORT),
];

export interface MockOptions {
  /** 初回起動時のヘルプを出したままにするか */
  showHelp?: boolean;
}

/**
 * サーバに届いた書き込み。既読同期（M4）は「送られたか」が見たいことの全てなので、
 * 応答は空で返し、届いた中身だけを控えておく。
 */
export interface ApiRecorder {
  readMarks: ReadMark[];
  unreadCalls: { entryId: number; unread: boolean }[];
  /** PATCH /api/feeds/:id で届いた設定変更 */
  updates: { id: number; params: UpdateFeedRequest }[];
  created: { url: string; rate?: number; folder?: string }[];
  deleted: number[];
  refetched: number[];
}

export async function mockApi(page: Page, options: MockOptions = {}): Promise<ApiRecorder> {
  const recorder: ApiRecorder = {
    readMarks: [],
    unreadCalls: [],
    updates: [],
    created: [],
    deleted: [],
    refetched: [],
  };

  if (options.showHelp !== true) {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), HELP_SEEN_KEY);
  }

  await page.route('**/api/bootstrap*', async (route) => {
    const body: BootstrapResponse = {
      serverTime: 1786000100,
      schemaVersion: 2,
      feeds: FEEDS,
      entries: ENTRIES,
      pins: [],
      maxEntryId: 21,
    };
    await route.fulfill({ json: body });
  });

  await page.route('**/api/entries*', async (route) => {
    const body: EntriesResponse = { entries: ENTRIES, nextSinceId: null, hasMore: false };
    await route.fulfill({ json: body });
  });

  await page.route('**/api/read', async (route) => {
    const body = route.request().postDataJSON() as ReadRequest;
    recorder.readMarks.push(...body.marks);
    const empty: ReadResponse = { feeds: [] };
    await route.fulfill({ json: empty });
  });

  await page.route('**/api/entries/*/unread', async (route) => {
    const entryId = Number(/\/entries\/(\d+)\/unread$/.exec(route.request().url())?.[1]);
    recorder.unreadCalls.push({ entryId, unread: route.request().method() === 'POST' });
    const empty: ReadResponse = { feeds: [] };
    await route.fulfill({ json: empty });
  });

  // 購読管理（M5）。サーバ側の検出とクロールは Vitest で見ているので、
  // ここでは「画面から呼べて、結果が一覧に反映される」ことだけを見る
  await page.route('**/api/feeds', async (route) => {
    const params = route.request().postDataJSON() as {
      url: string;
      rate?: number;
      folder?: string;
    };
    recorder.created.push(params);

    // サイトの URL を渡したときだけ候補を返す。候補（= フィードの URL）を
    // 選び直したときは普通に登録されないと、選択の意味が無い
    if (params.url === 'https://multi.example.com/') {
      await route.fulfill({
        status: 300,
        json: {
          candidates: [
            { url: 'https://multi.example.com/rss', title: '記事' },
            { url: 'https://multi.example.com/comments', title: 'コメント' },
          ],
        },
      });
      return;
    }

    const added = feed(9, '追加したフィード', params.rate ?? 3, 1);
    added.folder = params.folder ?? '';
    added.url = params.url;
    const body: CreateFeedResponse = {
      feed: added,
      entries: [entry(91, 9, '追加したフィードの記事', SHORT)],
    };
    await route.fulfill({ status: 201, json: body });
  });

  // glob の * は / をまたがないので、手動更新は別のパターンで受ける
  await page.route('**/api/feeds/*/fetch', async (route) => {
    const id = Number(/\/feeds\/(\d+)\/fetch$/.exec(route.request().url())?.[1]);
    recorder.refetched.push(id);
    const body: FetchFeedResponse = {
      feed: { ...FEEDS.find((candidate) => candidate.id === id)!, unreadCount: 1 },
      entries: [],
    };
    await route.fulfill({ json: body });
  });

  await page.route('**/api/feeds/*', async (route) => {
    const id = Number(/\/feeds\/(\d+)/.exec(route.request().url())?.[1]);

    if (route.request().method() === 'DELETE') {
      recorder.deleted.push(id);
      await route.fulfill({ json: { deleted: id } });
      return;
    }

    const params = route.request().postDataJSON() as UpdateFeedRequest;
    recorder.updates.push({ id, params });
    const current = FEEDS.find((candidate) => candidate.id === id)!;
    const body: FeedResponse = { feed: { ...current, ...params } };
    await route.fulfill({ json: body });
  });

  return recorder;
}
