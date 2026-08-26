/**
 * Worker と web で共有する型定義。docs/API.md の「型定義」節が正本。
 * 時刻は全て Unix 秒（整数）。ミリ秒と混在させない。
 */

/**
 * 取得に失敗した理由。last_error（人が読む文言）とは別に、機械的に扱うために持つ。
 *
 * 分類そのものは「何が起きたか」だけを表す。**どれを一括解除の対象にするかは
 * 画面側（SubscriptionManager.vue の REMOVABLE）が決める。** 同じ分類でも、
 * 1 回目の失敗で消してよいもの（404 は何度試しても 404）と、繰り返し失敗して
 * 初めて消してよいもの（接続断やタイムアウトは一時的にも起きる）があるため。
 */
export type FeedErrorKind =
  | 'not_found'
  | 'forbidden'
  | 'server_error'
  | 'not_a_feed'
  | 'unreachable'
  | 'timeout'
  | 'connection_lost'
  | 'other';

export interface Feed {
  id: number;
  url: string;
  siteUrl: string | null;
  title: string;
  iconUrl: string | null;
  rate: number; // 1..5
  folder: string; // "" は未分類
  readSeq: number; // 既読ウォーターマーク
  unreadCount: number;
  lastFetchedAt: number | null;
  lastError: string | null;
  lastErrorKind: FeedErrorKind | null;
  /** 連続で失敗した回数。1 回きりの失敗と、ずっと死んでいるものを区別する */
  consecutiveFailures: number;
  disabled: boolean;
  /**
   * 記事ページから本文を取ってくるか（M7）。要約しか配信しないフィード向け。
   * 既定は false で、決めるのはユーザ（相手のサーバに記事の数だけ取りに行くため）
   */
  fullText: boolean;
  /** クロール時に「要約しか配信していない」と見えた。購読管理画面で勧めるのに使う */
  fullTextSuggested: boolean;
}

export interface Entry {
  id: number; // 全体単調増加。順序と未読判定の基準
  feedId: number;
  url: string | null;
  title: string;
  author: string | null;
  body: string; // サニタイズ済み HTML
  publishedAt: number | null;
  storedAt: number;
}

export interface Pin {
  id: number;
  entryId: number | null;
  title: string;
  url: string;
  pinnedAt: number;
}

/**
 * GET /api/bootstrap
 *
 * 起動時の 1 リクエスト。このレスポンスだけで操作可能な状態になることが要件。
 */
export interface BootstrapResponse {
  serverTime: number;
  schemaVersion: number;
  /** レート降順 → 未読数降順。この並びが読む順序であり先読みの順序でもある */
  feeds: Feed[];
  /** 上位レートのフィードの未読記事 */
  entries: Entry[];
  pins: Pin[];
  /** この時点でサーバが持つ最大 entries.id。以降の差分取得のカーソル */
  maxEntryId: number;
}

/** GET /api/entries。残りの記事を背景で引くための一括取得 */
export interface EntriesResponse {
  /** id 昇順 */
  entries: Entry[];
  /** 続きがある場合の次の sinceId。無ければ null */
  nextSinceId: number | null;
  hasMore: boolean;
}

/** GET /api/sync。複数端末間の差分同期 */
export interface SyncResponse {
  serverTime: number;
  feeds: Feed[];
  /** entryCursor より大きい記事 */
  newEntries: Entry[];
  pins: Pin[];
  deletedPinIds: number[];
  maxEntryId: number;
}

/**
 * POST /api/read
 *
 * 既読ウォーターマークの更新。outbox からまとめて送られる。
 * 同じものを何度送っても、順序が入れ替わっても結果が変わらない（必ず MAX を取るため）。
 */
export interface ReadMark {
  feedId: number;
  /** 既読済みの最大 entries.id。これより後ろは未読のまま残る */
  watermark: number;
}

export interface ReadRequest {
  marks: ReadMark[];
}

/** 書き込み後のフィードの状態。クライアントは readSeq を Math.max で受ける */
export interface FeedReadState {
  id: number;
  readSeq: number;
  unreadCount: number;
}

/** POST /api/read と POST / DELETE /api/entries/:id/unread の応答 */
export interface ReadResponse {
  feeds: FeedReadState[];
}

/**
 * POST /api/feeds
 *
 * url はサイト URL でもフィード URL でもよい。サイト URL の場合は
 * <link rel="alternate"> からフィードを探す。
 */
export interface CreateFeedRequest {
  url: string;
  rate?: number;
  folder?: string;
}

/** 登録できた場合。登録直後に読めるよう、同期的な初回クロールの結果を添える */
export interface CreateFeedResponse {
  feed: Feed;
  entries: Entry[];
}

/** フィードが複数見つかった場合（HTTP 300）。どれを購読するかはユーザが選ぶ */
export interface FeedCandidatesResponse {
  candidates: { url: string; title: string | null }[];
  /**
   * 候補を見つけたページ。**貼られた URL と違うことがある。**
   *
   * 上の階層を遡って見つけた場合（note の記事ページなど）に、候補が 1 件でも
   * 選ばせる形になる。どこで見つけたものかが分からないと、利用者から見て
   * 「頼んでいないものを勧められている」ようにしか見えない
   */
  foundAt: string;
}

/** PATCH /api/feeds/:id。指定した項目だけを更新する */
export interface UpdateFeedRequest {
  rate?: number;
  folder?: string;
  /** フィードの名乗りを上書きするユーザ指定値 */
  title?: string;
  disabled?: boolean;
  fullText?: boolean;
}

export interface FeedResponse {
  feed: Feed;
}

/** POST /api/feeds/:id/fetch。entries は今回の取得で増えた分だけ */
export interface FetchFeedResponse {
  feed: Feed;
  entries: Entry[];
}

/** POST /api/opml */
export interface OpmlImportResponse {
  imported: number;
  /** 既に購読していて飛ばした数 */
  skipped: number;
  failed: { url: string; reason: string }[];
}

/**
 * POST /api/pins
 *
 * title と url は必須。記事が保持期間を過ぎて消えてもピンが生き残るよう、
 * 記事から引かずにピン自身が持つ（docs/API.md）。
 */
export interface CreatePinRequest {
  entryId: number | null;
  title: string;
  url: string;
}

export interface PinResponse {
  pin: Pin;
}

/** エラーレスポンスの形。HTTP ステータスは別に付く */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  ok: boolean;
  serverTime: number;
  schemaVersion: number;
  /** D1 に到達できたか。到達できない場合は ok=false で 503 を返す */
  db: 'ok' | 'error';
}

/**
 * 取り込みからこの日数が過ぎた既読記事は捨てる（docs/DESIGN.md §3「保持期間」）。
 *
 * サーバ（D1 から消す側）と画面（手元の IndexedDB から消す側）で同じ値を見る。
 * 手元だけ長く持っても、サーバに無い記事は次の起動で復元できないので意味が無い。
 */
export const RETENTION_DAYS = 30;

/**
 * 連続失敗がこの回数を超えたら、そのフィードの取得を止める（feeds.disabled = 1）。
 *
 * サーバ（取得を止める側）と画面（止まったことを知らせる側）の両方が同じ値を見る。
 * 片方だけ変えると、止まっているのに警告が出ない状態が生まれる。
 */
export const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * クライアントが持つデータの互換性判定に使う。
 * スキーマの破壊的変更時にインクリメントし、クライアントは IndexedDB を捨てて取り直す。
 *
 * 2: outbox（未送信の書き込み）と entryStates（手動で未読に戻した記事）を足した
 * 3: pins（ピン）を足した
 */
export const SCHEMA_VERSION = 3;
