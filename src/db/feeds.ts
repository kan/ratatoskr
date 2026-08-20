import type { Feed, FeedErrorKind, FeedReadState, ReadMark } from '../../shared/types';
import { CLEAR_FULL_BODIES } from './entries';
import { UNREAD_COUNT_SUBQUERY } from './unread';

/**
 * feeds に対するクエリ。SQL は src/db/ の外に書かない（CLAUDE.md）。
 */

interface FeedRow {
  id: number;
  url: string;
  site_url: string | null;
  title: string;
  icon_url: string | null;
  rate: number;
  folder: string;
  read_seq: number;
  unread_count: number;
  last_fetched_at: number | null;
  last_error: string | null;
  last_error_kind: string | null;
  consecutive_failures: number;
  disabled: number;
  full_text: number;
  full_text_suggested: number;
}

function toFeed(row: FeedRow): Feed {
  return {
    id: row.id,
    url: row.url,
    siteUrl: row.site_url,
    title: row.title,
    iconUrl: row.icon_url,
    rate: row.rate,
    folder: row.folder,
    readSeq: row.read_seq,
    unreadCount: row.unread_count,
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
    lastErrorKind: row.last_error_kind as FeedErrorKind | null,
    consecutiveFailures: row.consecutive_failures,
    disabled: row.disabled === 1,
    fullText: row.full_text === 1,
    // 2 は「ユーザが決めた」。勧めるのは 1 のときだけ（migrations/0003_full_text.sql）
    fullTextSuggested: row.full_text_suggested === 1,
  };
}

const FEED_COLUMNS = `f.id, f.url, f.site_url, f.title, f.icon_url, f.rate, f.folder, f.read_seq,
              f.last_fetched_at, f.last_error, f.last_error_kind, f.consecutive_failures,
              f.disabled, f.full_text, f.full_text_suggested`;

/**
 * 全フィードを未読数付きで返す。
 *
 * 並びは読む順序そのもの（レート降順 → 未読数降順）。左ペインの表示順であり、
 * 先読みの順序でもあるので、サーバ側で確定させてクライアントに渡す
 * （docs/DESIGN.md の「先読みが機能する前提条件」）。
 */
export async function selectFeeds(db: D1Database): Promise<Feed[]> {
  const { results } = await db
    .prepare(
      `SELECT ${FEED_COLUMNS}, ${UNREAD_COUNT_SUBQUERY} AS unread_count
         FROM feeds f
        ORDER BY f.rate DESC, unread_count DESC, f.id`,
    )
    .all<FeedRow>();
  return results.map(toFeed);
}

/**
 * 既読ウォーターマークの更新。
 *
 * **必ず MAX を取る**（CLAUDE.md の不変条件 1）。単調増加であることが複数端末同期の
 * 唯一の保証なので、SET read_seq = ? と書いた瞬間に巻き戻りが発生する。
 * MAX である限り、重複しても順序が入れ替わっても結果は変わらない。
 *
 * 存在しないフィード id は 0 行更新になるだけで、エラーにはしない
 * （他端末で購読を消した後に届く送信が失敗し続けるのを避ける）。
 */
export async function applyReadMarks(db: D1Database, marks: ReadMark[]): Promise<void> {
  if (marks.length === 0) return;
  const statement = db.prepare('UPDATE feeds SET read_seq = MAX(read_seq, ?) WHERE id = ?');
  // D1 には長時間トランザクションが無いので batch() にまとめる（CLAUDE.md）
  await db.batch(marks.map((mark) => statement.bind(mark.watermark, mark.feedId)));
}

/** 書き込み後の状態。応答に載せて、クライアントが自分の値と突き合わせられるようにする */
export async function selectFeedReadStates(
  db: D1Database,
  ids: number[],
): Promise<FeedReadState[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT f.id, f.read_seq, ${UNREAD_COUNT_SUBQUERY} AS unread_count
         FROM feeds f
        WHERE f.id IN (${placeholders})
        ORDER BY f.id`,
    )
    .bind(...ids)
    .all<{ id: number; read_seq: number; unread_count: number }>();
  return results.map((row) => ({
    id: row.id,
    readSeq: row.read_seq,
    unreadCount: row.unread_count,
  }));
}

/** 1 件だけ引く。登録・更新の応答と、購読管理画面の再描画に使う */
export async function selectFeedById(db: D1Database, id: number): Promise<Feed | null> {
  const row = await db
    .prepare(
      `SELECT ${FEED_COLUMNS}, ${UNREAD_COUNT_SUBQUERY} AS unread_count
         FROM feeds f
        WHERE f.id = ?`,
    )
    .bind(id)
    .first<FeedRow>();
  return row === null ? null : toFeed(row);
}

export interface NewFeed {
  url: string;
  siteUrl: string | null;
  title: string;
  rate: number;
  folder: string;
}

/**
 * 購読の追加。1 件でも一括でも同じ列・同じ並びで入れる。
 * next_fetch_at は 0 にして、登録直後のクロール（同期・cron のどちらでも）に拾わせる。
 */
const INSERT_FEED = `INSERT OR IGNORE INTO feeds
       (url, site_url, title, rate, folder, next_fetch_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`;

function bindNewFeed(
  statement: D1PreparedStatement,
  feed: NewFeed,
  now: number,
): D1PreparedStatement {
  return statement.bind(feed.url, feed.siteUrl, feed.title, feed.rate, feed.folder, now);
}

/**
 * 1 件だけ追加する。url は UNIQUE なので、既に購読していれば null を返す
 * （呼び出し側が「登録済み」として扱えるように、例外にはしない）。
 */
export async function insertFeed(
  db: D1Database,
  feed: NewFeed,
  now: number,
): Promise<number | null> {
  const row = await bindNewFeed(db.prepare(`${INSERT_FEED} RETURNING id`), feed, now).first<{
    id: number;
  }>();
  return row?.id ?? null;
}

// D1 の 1 バッチが際限なく膨らまないように区切る（insertEntries と同じ考え方）
const INSERT_BATCH_SIZE = 50;

/**
 * まとめて購読を追加する（OPML の取り込み）。
 *
 * 1 件ずつ INSERT すると、件数ぶんのステートメントが 1 リクエストに積み上がる。
 * D1 には長時間トランザクションが無いので batch() にまとめる（CLAUDE.md）。
 *
 * @returns 実際に追加された件数。既に購読している URL は UNIQUE 制約で黙って落ちる
 */
export async function insertFeeds(db: D1Database, feeds: NewFeed[], now: number): Promise<number> {
  if (feeds.length === 0) return 0;

  const statement = db.prepare(INSERT_FEED);

  let inserted = 0;
  for (let i = 0; i < feeds.length; i += INSERT_BATCH_SIZE) {
    const results = await db.batch(
      feeds.slice(i, i + INSERT_BATCH_SIZE).map((feed) => bindNewFeed(statement, feed, now)),
    );
    for (const result of results) inserted += result.meta.changes ?? 0;
  }
  return inserted;
}

export interface FeedSettings {
  rate?: number;
  folder?: string;
  /** フィードの名乗りを上書きするユーザ指定値 */
  title?: string;
  disabled?: boolean;
  /** 記事ページから本文を取ってくるか（M7） */
  fullText?: boolean;
}

/**
 * ユーザが決める設定だけを更新する。クロール制御の列（etag / next_fetch_at 等）は
 * ここから触らない。指定のあった項目だけを書き換える。
 */
export async function updateFeedSettings(
  db: D1Database,
  id: number,
  settings: FeedSettings,
): Promise<boolean> {
  const assignments: string[] = [];
  const params: (string | number)[] = [];

  if (settings.rate !== undefined) {
    assignments.push('rate = ?');
    params.push(settings.rate);
  }
  if (settings.folder !== undefined) {
    assignments.push('folder = ?');
    params.push(settings.folder);
  }
  if (settings.title !== undefined) {
    assignments.push('title = ?');
    params.push(settings.title);
  }
  if (settings.disabled !== undefined) {
    assignments.push('disabled = ?');
    params.push(settings.disabled ? 1 : 0);
  }
  if (settings.fullText !== undefined) {
    assignments.push('full_text = ?');
    params.push(settings.fullText ? 1 : 0);
    // 勧める必要はもう無い。入れたのであれ断ったのであれ、ユーザが決めた。
    // 0 に戻すと次のクロールで同じ判定が出て勧めが復活するので、2 を入れる
    assignments.push('full_text_suggested = 2');
  }
  // 無効化を解除したら次の cron で拾えるようにする。
  // 連続失敗で自動的に無効化されたフィードを、手で戻せるようにするため
  if (settings.disabled === false) {
    assignments.push('consecutive_failures = 0', 'next_fetch_at = 0');
  }
  if (assignments.length === 0) return true;

  params.push(id);
  const update = db
    .prepare(`UPDATE feeds SET ${assignments.join(', ')} WHERE id = ?`)
    .bind(...params);

  // 全文取得を切ったら、取ってあった本文も捨てる。読み出しは COALESCE なので、
  // 捨てないと「抽出が本文でないものを掴んでいた」ときに元へ戻す手段が無くなる。
  // 設定と後始末を 1 つの batch にまとめて、片方だけ適用された状態を作らない
  const statements =
    settings.fullText === false ? [update, db.prepare(CLEAR_FULL_BODIES).bind(id)] : [update];

  const [result] = await db.batch(statements);
  return (result.meta.changes ?? 0) > 0;
}

/** 記事は CASCADE で消える。ピンは非正規化してあるので残る（docs/DESIGN.md） */
export async function deleteFeed(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM feeds WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** クローラが 1 フィードを処理するのに必要な列だけを引く */
export interface CrawlTarget {
  id: number;
  url: string;
  title: string;
  siteUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  fetchInterval: number;
  consecutiveFailures: number;
  /** 記事ページから本文を取ってくるか（M7） */
  fullText: boolean;
  /** 記事ページのどこが本文か。NULL なら次の取得時に判定する */
  fullTextSelector: string | null;
}

interface CrawlTargetRow {
  id: number;
  url: string;
  title: string;
  site_url: string | null;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  fetch_interval: number;
  consecutive_failures: number;
  full_text: number;
  full_text_selector: string | null;
}

function toCrawlTarget(row: CrawlTargetRow): CrawlTarget {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    siteUrl: row.site_url,
    etag: row.etag,
    lastModified: row.last_modified,
    contentHash: row.content_hash,
    fetchInterval: row.fetch_interval,
    consecutiveFailures: row.consecutive_failures,
    fullText: row.full_text === 1,
    fullTextSelector: row.full_text_selector,
  };
}

const CRAWL_COLUMNS = `id, url, title, site_url, etag, last_modified, content_hash,
         fetch_interval, consecutive_failures, full_text, full_text_selector`;

/**
 * 期限が来たフィードを古い順に取る。LIMIT は必ず付ける
 * （1 リクエストあたりのサブリクエスト上限。docs/DESIGN.md §5）。
 */
export async function selectCrawlTargets(
  db: D1Database,
  now: number,
  limit: number,
): Promise<CrawlTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CRAWL_COLUMNS}
         FROM feeds
        WHERE disabled = 0 AND next_fetch_at <= ?
        ORDER BY next_fetch_at
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<CrawlTargetRow>();
  return results.map(toCrawlTarget);
}

/** 手動クロール（M5 の POST /api/feeds/:id/fetch）や運用時の指名取得に使う */
export async function selectCrawlTargetsByIds(
  db: D1Database,
  ids: number[],
): Promise<CrawlTarget[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT ${CRAWL_COLUMNS} FROM feeds WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<CrawlTargetRow>();
  return results.map(toCrawlTarget);
}

export interface FetchSuccessParams {
  id: number;
  now: number;
  nextFetchAt: number;
  fetchInterval: number;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  /** フィードが名乗るタイトル。既に値が入っている場合は上書きしない */
  title: string;
  siteUrl: string | null;
}

/**
 * 本文を取得できた場合の更新。
 *
 * title / site_url は「まだ空のときだけ」入れる。M5 でユーザがリネームできるように
 * なるので、毎回フィード側の値で上書きすると手で付けた名前が消える。
 */
export async function markFetchSuccess(db: D1Database, p: FetchSuccessParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET etag = ?, last_modified = ?, content_hash = ?,
              next_fetch_at = ?, fetch_interval = ?,
              consecutive_failures = 0, last_error = NULL, last_error_kind = NULL,
              last_fetched_at = ?,
              title = CASE WHEN title = '' THEN ? ELSE title END,
              site_url = COALESCE(site_url, ?)
        WHERE id = ?`,
    )
    .bind(
      p.etag,
      p.lastModified,
      p.contentHash,
      p.nextFetchAt,
      p.fetchInterval,
      p.now,
      p.title,
      p.siteUrl,
      p.id,
    )
    .run();
}

export interface FetchUnchangedParams {
  id: number;
  now: number;
  nextFetchAt: number;
  fetchInterval: number;
}

/** 304、または content_hash 一致でパースを省いた場合 */
export async function markFetchUnchanged(db: D1Database, p: FetchUnchangedParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET next_fetch_at = ?, fetch_interval = ?,
              consecutive_failures = 0, last_error = NULL, last_error_kind = NULL,
              last_fetched_at = ?
        WHERE id = ?`,
    )
    .bind(p.nextFetchAt, p.fetchInterval, p.now, p.id)
    .run();
}

export interface FetchFailureParams {
  id: number;
  now: number;
  nextFetchAt: number;
  /** 今回の失敗を含めた連続失敗回数 */
  failures: number;
  message: string;
  /** 機械的に扱うための分類。購読管理画面の一括解除がこれで対象を選ぶ */
  reason: FeedErrorKind;
  disabled: boolean;
}

/** 取得・パースの失敗。握りつぶさず last_error に残して次回に活かす（CLAUDE.md） */
export async function markFetchFailure(db: D1Database, p: FetchFailureParams): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
          SET next_fetch_at = ?, consecutive_failures = ?, last_error = ?, last_error_kind = ?,
              last_fetched_at = ?, disabled = ?
        WHERE id = ?`,
    )
    .bind(p.nextFetchAt, p.failures, p.message, p.reason, p.now, p.disabled ? 1 : 0, p.id)
    .run();
}

/**
 * 記事ページのどこが本文かを覚える（src/crawler/choose.ts が決めた結果）。
 * null を渡すと忘れさせる。サイトが作り替えられて引けなくなったときに、
 * 次の取得で判定し直させるために使う。
 */
export async function updateFullTextSelector(
  db: D1Database,
  id: number,
  selector: string | null,
  source: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE feeds SET full_text_selector = ?, full_text_source = ? WHERE id = ?')
    .bind(selector, source, id)
    .run();
}

/**
 * 「要約しか配信していない」と見えたことを覚える。購読管理画面で勧めるだけで、
 * 取りに行き始めはしない（相手のサーバに記事の数だけ取りに行く動作なので、
 * こちらが勝手に決めない）。
 *
 * 既にユーザが決めた後（full_text_suggested = 2）は触らない。触ると、勧めを断った
 * フィードで次のクロックごとに勧めが復活する。
 */
export async function markFullTextSuggested(db: D1Database, id: number): Promise<void> {
  await db
    .prepare('UPDATE feeds SET full_text_suggested = 1 WHERE id = ? AND full_text_suggested = 0')
    .bind(id)
    .run();
}
