import { selectRobots, upsertRobots, type StoredRobots } from '../db/robots';
import { errorMessage } from '../lib/errors';
import { readBoundedMarkup, TIMEOUT_MS, USER_AGENT, type FetchBudget } from './fetch';
import {
  isAllowed,
  MAX_ROBOTS_BYTES,
  parseRobots,
  RobotsDisallowedError,
  RobotsUnavailableError,
  stateForStatus,
  type RobotsRules,
} from './robots';

/**
 * クロール 1 回の間、相手のサーバへの行儀を守らせる fetch の包み（issue #39）。
 *
 * クローラの外向きの要求は全て `fetchImpl` を通るので、包むだけで経路ごとに
 * 書き足さずに済む（フィード本体・記事ページ・埋め込み・各ソースの API）。
 *
 * - **同じホストへは同時に 1 本まで。** フィードの並列度（src/crawler/index.ts）は
 *   フィード単位なので、同じサイトの複数カテゴリを購読していると、同じホストを
 *   同時に叩いていた
 * - **流量の制限（429 / 503）を受けたら、その回はもうそのホストへ出さない。**
 *   同じホストの残りの要求には、受けた応答と同じ状態を返す（ネットワークには出ない）。
 *   フィードの取得なら `Retry-After` を引き継いで次回の取得時刻が延びる
 * - 記事ページ（`page`）は、加えて robots.txt（RFC 9309）を見る
 *
 * 1 回のクロールで作って捨てる。状態を持ち越さないので、次の cron は白紙から始まる
 * （持ち越すべき待ちは、フィードの next_fetch_at と robots.txt の控えに残っている）。
 */

/** robots.txt の控えの寿命。RFC 9309 §2.4 の上限 */
const ROBOTS_TTL = 86_400;
/**
 * 取れなかった（5xx・接続できない・429）ときの控えの寿命。
 *
 * 全て禁じる扱いなので、24 時間も持つとその間の全文取得が止まる。相手が直るのを
 * 待つのに十分な程度に短くする
 */
const ROBOTS_FAILURE_TTL = 3_600;

export interface PoliteFetch {
  /** フィード本体や API。ホストごとに 1 本ずつ、流量の制限を受けたら以降は出さない */
  fetch: typeof fetch;
  /**
   * 記事ページ。`fetch` の決まりに加えて robots.txt を見る。
   * 禁じられていれば `RobotsDisallowedError`、robots.txt を取れなければ
   * `RobotsUnavailableError` を投げる（src/crawler/fetch.ts の fetchArticlePage と fetchFeed）
   */
  page: typeof fetch;
}

export interface PoliteOptions {
  /** robots.txt の控え。無ければ毎回取りに行く（テスト用） */
  db?: D1Database;
  now: number;
  /**
   * robots.txt を取りに行くときに引く枠（全文取得と共有。src/crawler/index.ts）。
   * サブリクエスト上限のため、記事ページと同じく数える（docs/DESIGN.md §5）。
   * 省けば上限なし（購読の追加のような 1 回きりの経路）
   */
  budget?: FetchBudget;
}

export function createPoliteFetch(fetchImpl: typeof fetch, options: PoliteOptions): PoliteFetch {
  /** ホストごとの最後尾。次の要求はこれが済むのを待つ */
  const tails = new Map<string, Promise<void>>();
  /** 流量の制限を受けたホストと、そのとき受けた応答の頭 */
  const cooled = new Map<string, { status: number; retryAfter: string | null }>();
  /** robots.txt の読み込み。同じ回に同じサイトを何度も見に行かない */
  const robots = new Map<string, Promise<RobotsRules>>();

  /**
   * @param coolOn503 503 を受けたらホストを冷やすか（429 は常に冷やす）。robots.txt の
   *   取得では冷やさない。robots.txt だけが 503 を返すサイトで、同じホストのフィード本体まで
   *   失敗に数えないため（robots.txt を取れなかったことは、控えの方で 1 時間覚えている）。
   *   429 は「こちらの要求が多い」という明示なので、どの要求で受けても従う
   */
  const send = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    coolOn503: boolean,
  ): Promise<Response> => {
    const host = hostOf(input);
    if (host === null) return fetchImpl(input, init);

    const previous = tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    tails.set(host, tail);

    await previous;
    try {
      const blocked = cooled.get(host);
      if (blocked !== undefined) return cooledResponse(blocked);

      // **応答の頭が返った時点で次に譲る。** 本文を読み終えるまで握ると、エラー応答の
      // ように本文を読まずに捨てる経路で、同じホストの後続が打ち切りまで詰まる
      const response = await fetchImpl(input, init);
      if (response.status === 429 || (coolOn503 && response.status === 503)) {
        cooled.set(host, {
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
        });
      }
      return response;
    } finally {
      release();
      if (tails.get(host) === tail) tails.delete(host);
    }
  };
  const politeFetch = (input: RequestInfo | URL, init?: RequestInit) => send(input, init, true);
  const robotsFetch = (input: RequestInfo | URL, init?: RequestInit) => send(input, init, false);

  const rulesFor = (origin: string): Promise<RobotsRules> => {
    let loading = robots.get(origin);
    if (loading === undefined) {
      loading = loadRobots(origin, robotsFetch as typeof fetch, options);
      robots.set(origin, loading);
    }
    return loading;
  };

  const page = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return politeFetch(input, init);
    }
    const rules = await rulesFor(origin);
    // disallow_all は取れなかったときにしか付かない（stateForStatus）。本文で全て
    // 禁じたサイトは state が ok で、規則の方に `Disallow: /` が入る
    if (rules.state === 'disallow_all') throw new RobotsUnavailableError(url, ROBOTS_FAILURE_TTL);
    if (!isAllowed(rules, url)) throw new RobotsDisallowedError(url);
    return politeFetch(input, init);
  };

  return {
    fetch: politeFetch as typeof fetch,
    page: page as typeof fetch,
  };
}

function cooledResponse(blocked: { status: number; retryAfter: string | null }): Response {
  const headers = new Headers();
  if (blocked.retryAfter !== null) headers.set('retry-after', blocked.retryAfter);
  return new Response(null, {
    status: blocked.status,
    statusText: 'Rate limited earlier in this crawl',
    headers,
  });
}

/**
 * robots.txt を控えから、無ければ取りに行って読む。
 *
 * **D1 が引けなくてもクロールは止めない。** 控えは要求を減らすためのもので、
 * 無ければ毎回取りに行くだけで済む
 */
async function loadRobots(
  origin: string,
  fetchImpl: typeof fetch,
  options: PoliteOptions,
): Promise<RobotsRules> {
  const { db, now } = options;
  let stored: StoredRobots | null = null;
  if (db !== undefined) {
    try {
      stored = await selectRobots(db, origin);
    } catch (err) {
      console.warn('robots.txt の控えを引けない', origin, errorMessage(err));
    }
  }
  if (stored !== null && stored.expiresAt > now) return rulesOf(stored);

  // **枠から引くが、尽きていても断らない。** 断ると「枠が足りない」が「禁じられている」に
  // 化けて、記事に取り直しを止める印が付く。robots.txt を取るのは、既に枠を確保した
  // 記事ページの前だけ（origin ごとに 1 回）なので、追加は記事ページの数を超えない。
  // 引いた分は後続の記事ページの枠を減らす
  if (options.budget !== undefined) options.budget.remaining -= 1;
  const fetched = await fetchRobots(origin, fetchImpl, now);
  // 取れなかったときは、期限切れでも前の控えに従う（RFC 9309 §2.4。相手が一時的に
  // 落ちているだけで全文取得を止めない）。前の控えも無ければ全て禁じる
  if (fetched.state === 'disallow_all' && stored !== null && stored.state !== 'disallow_all') {
    return rulesOf(stored);
  }
  if (db !== undefined) {
    try {
      await upsertRobots(db, origin, fetched, now);
    } catch (err) {
      console.warn('robots.txt を控えられない', origin, errorMessage(err));
    }
  }
  return rulesOf(fetched);
}

function rulesOf(stored: StoredRobots): RobotsRules {
  if (stored.state === 'ok') return parseRobots(stored.body);
  return { state: stored.state, rules: [] };
}

async function fetchRobots(
  origin: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<StoredRobots> {
  const failed: StoredRobots = {
    state: 'disallow_all',
    body: '',
    expiresAt: now + ROBOTS_FAILURE_TTL,
  };
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, */*;q=0.5' },
      // RFC 9309 §2.3.1.2: リダイレクトは 5 回までたどってよい。fetch の既定（20 回）に任せる
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('robots.txt の取得に失敗', origin, errorMessage(err));
    return failed;
  }

  const byStatus = stateForStatus(response.status);
  if (byStatus === 'allow_all')
    return { state: 'allow_all', body: '', expiresAt: now + ROBOTS_TTL };
  if (byStatus === 'disallow_all') return failed;

  const read = await readBoundedMarkup(response);
  if (read.kind === 'error') return failed;
  return { state: 'ok', body: read.body.slice(0, MAX_ROBOTS_BYTES), expiresAt: now + ROBOTS_TTL };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hostOf(input: RequestInfo | URL): string | null {
  try {
    return new URL(urlOf(input)).host;
  } catch {
    return null;
  }
}
