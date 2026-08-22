import type { Page } from '@playwright/test';
import type {
  BootstrapResponse,
  CreatePinRequest,
  CreateFeedResponse,
  EntriesResponse,
  Entry,
  Feed,
  FeedResponse,
  FetchFeedResponse,
  ReadMark,
  ReadRequest,
  PinResponse,
  ReadResponse,
  UpdateFeedRequest,
} from '../shared/types';
import { HELP_SEEN_KEY } from '../web/src/lib/prefs';
import { CACHE_NAME } from '../web/src/lib/prefetch';

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
    lastErrorKind: null,
    consecutiveFailures: 0,
    disabled: false,
    fullText: false,
    fullTextSuggested: false,
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
/** 先読み（M7）を見るための画像。1x1 なので本文の高さには効かない */
const image = (id: number): string => `<img src="https://img.example.com/${id}.jpg" alt="">`;
// スクロールが発生する長さ。Space の境界挙動を試すために使う
const LONG = '<p>長い本文</p>'.repeat(400);

function failing(
  id: number,
  title: string,
  error: string,
  kind: Feed['lastErrorKind'],
  consecutiveFailures = 1,
): Feed {
  return { ...feed(id, title, 1, 0), lastError: error, lastErrorKind: kind, consecutiveFailures };
}

/**
 * フィード 3 本 + 取得に失敗している 3 本。
 *   1: ★5 未読 2（1 件目が長文）
 *   2: ★3 未読 1
 *   3: ★1 未読 0 … s / a で飛ばされることの確認用
 *   4: 404 が 1 回 … 一括解除の対象（何度引いても 404）
 *   5: タイムアウトが 2 回 … 一括解除の対象（続いているので放置とみなす）
 *   6: 接続断 … 一括解除の対象外（相手の一時障害で普通に起きる）
 *   7: タイムアウトが 1 回 … 一括解除の対象外（1 回では消さない）
 *   8: 500 が続いて取得を止められた … 左ペインの警告の対象（M9）
 */
export const FEEDS: Feed[] = [
  feed(1, '朝刊', 5, 2),
  // 夕刊は要約しか配信していないと見えたフィード（M7 の全文取得を勧める側）
  { ...feed(2, '夕刊', 3, 1), fullTextSuggested: true },
  feed(3, '既読済み', 1, 0),
  failing(4, '消えたブログ', 'HTTP 404 Not Found', 'not_found'),
  failing(5, '重いサイト', '応答が無い（15 秒で打ち切り）', 'timeout', 2),
  failing(6, '不安定なサイト', '接続が途中で切れた', 'connection_lost'),
  failing(7, 'たまたま遅いサイト', '応答が無い（15 秒で打ち切り）', 'timeout'),
  // 連続失敗がしきい値を超え、サーバが取得を止めたフィード
  {
    ...failing(8, '止まったサイト', 'HTTP 500 Internal Server Error', 'server_error', 21),
    disabled: true,
  },
];

export const ENTRIES: Entry[] = [
  entry(11, 1, '朝刊の 1 本目', LONG),
  entry(12, 1, '朝刊の 2 本目', SHORT + image(12)),
  entry(21, 2, '夕刊の 1 本目', SHORT + image(21)),
];

/** 画像の先読みが使う Cache API の名前。名前がずれると検証が空振りするので import する */
export const IMAGE_CACHE = CACHE_NAME;

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
  pinned: CreatePinRequest[];
  unpinned: number[];
  unreadCalls: { entryId: number; unread: boolean }[];
  /** PATCH /api/feeds/:id で届いた設定変更 */
  updates: { id: number; params: UpdateFeedRequest }[];
  created: { url: string; rate?: number; folder?: string }[];
  deleted: number[];
  refetched: number[];
  /** 先読み（M7）が取りに行った画像。届いた順に入る */
  images: string[];
}

export async function mockApi(page: Page, options: MockOptions = {}): Promise<ApiRecorder> {
  /**
   * PATCH で書き換えられた設定。フィードを返す全ての経路がこれを重ねる。
   * 重ねないと、設定を変えた直後の手動更新がサーバの初期値で上書きしてしまう
   * （実際のサーバは書き換え後の値を返す）
   */
  const patched = new Map<number, Partial<Feed>>();
  const current = (id: number): Feed => ({
    ...FEEDS.find((candidate) => candidate.id === id)!,
    ...patched.get(id),
  });

  const recorder: ApiRecorder = {
    readMarks: [],
    pinned: [],
    unpinned: [],
    unreadCalls: [],
    updates: [],
    created: [],
    deleted: [],
    refetched: [],
    images: [],
  };

  if (options.showHelp !== true) {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), HELP_SEEN_KEY);
  }

  // 画像は全ての spec で握る。外に取りに行かせると、先読みの有無に関わらず
  // 実在しないホストへの往復で不安定になる
  await page.route('https://img.example.com/**', async (route) => {
    recorder.images.push(route.request().url());
    await route.fulfill({
      contentType: 'image/gif',
      // 実在する画像サーバと同じく、キャッシュしてよいことを名乗る。
      // これが無いと先読みで温めた分がブラウザの HTTP キャッシュに残らず、
      // 「先読みが効いているか」を確かめられない
      headers: { 'cache-control': 'public, max-age=3600' },
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
    });
  });

  await page.route('**/api/bootstrap*', async (route) => {
    const body: BootstrapResponse = {
      serverTime: 1786000100,
      schemaVersion: 3,
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
    const body: FetchFeedResponse = { feed: { ...current(id), unreadCount: 1 }, entries: [] };
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
    patched.set(id, { ...patched.get(id), ...params });
    const body: FeedResponse = { feed: current(id) };
    await route.fulfill({ json: body });
  });

  await page.route('**/api/pins', async (route) => {
    const params = route.request().postDataJSON() as CreatePinRequest;
    recorder.pinned.push(params);
    const body: PinResponse = {
      pin: { id: 900 + recorder.pinned.length, ...params, pinnedAt: 1786000200 },
    };
    await route.fulfill({ status: 201, json: body });
  });

  await page.route('**/api/pins/*', async (route) => {
    const id = Number(/\/pins\/(\d+)$/.exec(route.request().url())?.[1]);
    recorder.unpinned.push(id);
    await route.fulfill({ json: { deleted: id } });
  });

  return recorder;
}
