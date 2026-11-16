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

/** 取得定義を誰が作ったか（issue #40。migrations/0009_feeds_recipe.sql） */
/**
 * メールマガジン（issue #41）の送信者のフィードの URL の頭。`mailto:<送信者>` で作り、
 * これで見分ける（クロールの対象から外す・購読管理画面の説明）。作る側と見分ける側で
 * 同じ値を見る
 */
export const MAIL_FEED_PREFIX = 'mailto:';

export const RECIPE_SOURCES = ['ai', 'score', 'manual'] as const;
export type RecipeSource = (typeof RECIPE_SOURCES)[number];

export function isRecipeSource(value: unknown): value is RecipeSource {
  return (RECIPE_SOURCES as readonly unknown[]).includes(value);
}

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
  /**
   * 全文取得で、記事ページの取得が robots.txt に禁じられていた（issue #39）。
   * 全文取得を入れたのに本文が埋まらない理由を、購読管理画面で見せるのに使う
   */
  fullTextBlocked: boolean;
  /**
   * RSS を出さないサイトを、取得定義で読んでいるか（issue #40）。誰が作った定義か。
   * ai / score は購読の追加でページから推定したもの、manual は手で書いて貼ったもの。
   * RSS や既知のソースで読んでいるフィードは null
   */
  recipeSource: RecipeSource | null;
  /**
   * 日本語以外の記事を訳すか（issue #42）。既定は false で、決めるのはユーザ
   * （Workers AI の無料枠を記事の数だけ使うため）
   */
  translate: boolean;
  /** クロール時に「日本語ではない」と見えた。購読管理画面で勧めるのに使う */
  translateSuggested: boolean;
  /**
   * 最近ほとんど読まずに送っている（issue #43）。購読管理画面で、レートを下げるか
   * 解除することを勧めるのに使う。1 日 1 回付け直す
   */
  skimmed: boolean;
  /**
   * 表示を有効にした端末でしか出さない（issue #23）。**隠すのは画面側。**
   * サーバは全ての端末に同じものを配り、どの端末で出すかは端末ごとの設定で決まる
   * （web/src/stores/nsfw.ts）
   */
  nsfw: boolean;
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
  /**
   * 訳文（issue #42）。訳したものだけに付く。原文（title / body）はそのまま残し、
   * どちらを出すかは画面が決める（既定は訳文。t キーで原文と切り替える）
   */
  translation?: { title: string; body: string };
}

/**
 * 読み方のデータ（issue #43）。端末で記録して outbox から送る。id は端末が振り、
 * 同じものが二度届いてもサーバは 1 件にする（冪等）
 */
export type ReadingEvent =
  /** 記事を表示していた時間。フォーカスがあり、最後の操作から 60 秒以内の時間だけを数える */
  | { id: string; kind: 'dwell'; at: number; feedId: number; entryId: number; seconds: number }
  /** 本文中のリンクを開いた */
  | { id: string; kind: 'link'; at: number; feedId: number; entryId: number; url: string }
  /** 元記事を開いた（v） */
  | { id: string; kind: 'open'; at: number; feedId: number; entryId: number };

export interface ReadingEventsRequest {
  events: ReadingEvent[];
}

/** POST /api/events が 1 回に受ける件数。送る側（web/src/stores/outbox.ts）も同じ値で区切る */
export const MAX_EVENTS_PER_REQUEST = 200;

export interface Pin {
  id: number;
  entryId: number | null;
  title: string;
  url: string;
  pinnedAt: number;
  /**
   * NSFW のフィードの記事に立てたピン（issue #23）。**ピンを立てた時点のフィードの印を
   * 写したもの。** ピンは記事より長生きするので、後からフィードを辿って決められない
   */
  nsfw: boolean;
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
  /**
   * entryCursor 以下の未読のうち、since 以降に本文が変わった記事（全文が後から
   * 入った・全文取得を切って要約に戻った）。手元の同じ id の記事を置き換える
   */
  updatedEntries: Entry[];
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
  /**
   * RSS を出さないサイトの取得定義（issue #40）。指定すると自動検出をせず、この定義で
   * 読むフィードとして登録する。中身はサーバが確かめる（src/crawler/recipe.ts の parseRecipe）
   *
   * 候補（FeedCandidatesResponse）に付いてきた定義をそのまま返すか、開発時に書いた
   * 定義を貼る。前者は recipeSource に候補の値（ai / score）を添える
   */
  recipe?: unknown;
  recipeSource?: RecipeSource;
}

/** 登録できた場合。登録直後に読めるよう、同期的な初回クロールの結果を添える */
export interface CreateFeedResponse {
  feed: Feed;
  entries: Entry[];
}

/** フィードが複数見つかった場合（HTTP 300）。どれを購読するかはユーザが選ぶ */
export interface FeedCandidate {
  url: string;
  title: string | null;
  /**
   * フィードが見つからず、ページから取得定義を推定した候補（issue #40）。
   * 選んだら CreateFeedRequest にそのまま載せて送り返す
   */
  recipe?: unknown;
  recipeSource?: RecipeSource;
  /** 推定した定義で取れた記事の見出し。何を購読することになるかを見せる */
  preview?: string[];
}

export interface FeedCandidatesResponse {
  candidates: FeedCandidate[];
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
  nsfw?: boolean;
  /** 日本語以外の記事を訳すか（issue #42） */
  translate?: boolean;
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
  /**
   * 見出し。**空でよい。** タイトルを配らないフィードの記事は title が空なので、
   * ここで必須にすると、その記事をピンした瞬間に 400 になる（issue #11）。
   * 空で届いたときはサーバが記事の本文から作る（src/api/pins.ts）
   */
  title: string;
  url: string;
  /**
   * 記事のフィードに NSFW の印が付いていたか（issue #23）。**サーバが記事から引けない
   * ときの控え。** 記事が残っていればサーバはそちらを採る。手元にはあるがサーバでは
   * もう消えた記事をピンしたときに、これが無いと印なしで保存される。省けば false
   */
  nsfw?: boolean;
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
 * このアプリ自身の在り処。
 *
 * 画面のリンク（ヘルプと購読管理）と、クローラが名乗る User-Agent の両方が同じ値を見る。
 * 書き写すと、移転したときに画面のリンクだけ直り、名乗りが死んだ URL を指したまま残る。
 */
export const REPOSITORY_URL = 'https://github.com/kan/ratatoskr';

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
