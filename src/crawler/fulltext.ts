import {
  clearRejectedFullText,
  selectMissingFullText,
  updateFullBodies,
  type FullTextTarget,
} from '../db/entries';
import { updateFullTextSelector, type CrawlTarget } from '../db/feeds';
import { chooseBodySelector } from './choose';
import { resolveTweetEmbeds } from './embed';
import { scanCandidates } from './extract';
import { sanitizeWithin } from './sanitize';
import {
  describeNetworkError,
  readBoundedText,
  releaseBudget,
  reserveBudget,
  TIMEOUT_MS,
  USER_AGENT,
  type FetchBudget,
} from './fetch';

/**
 * 要約しか配信しないフィードの本文を、記事ページから取ってくる（M7）。
 *
 * 取り込みと同じクロールの中でやる。読む時点では既に手元にある形にしたいので、
 * 「読もうとしたときに取りに行く」形は採らない（それでは待ちが出るし、待ちを
 * 消すことがこのアプリの唯一の目標。docs/DESIGN.md §1）。
 *
 * 相手のサーバへの礼儀として、取りに行く数は二重に絞る。
 *
 *   - 1 フィードにつき 1 回のクロールで MAX_ARTICLES_PER_FEED 件まで
 *   - cron 1 回の実行で全フィード合わせて（呼び出し側が渡す budget）まで
 *
 * 後者はサブリクエスト上限のためでもある（docs/DESIGN.md §5）。フィード本体の
 * 取得が 20 本走った後に、記事ページを無制限に足すわけにはいかない。
 */

/** 1 フィードにつき 1 回のクロールで取りに行く記事数 */
const MAX_ARTICLES_PER_FEED = 10;

/** 同じサーバへ同時に投げる数。フィード本体（4）より控えめにする */
const CONCURRENCY = 2;

const ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';

export interface FullTextOptions {
  fetchImpl: typeof fetch;
  /** 本文の位置を判定させる。未設定なら点数だけで決める（src/crawler/choose.ts） */
  ai: Ai | undefined;
  /** 記事ページと埋め込みの取得で共有する予算 */
  budget: FetchBudget;
}

export interface FullTextResult {
  /** 全文を書き込めた記事の id */
  filled: number[];
}

export async function fillFullText(
  db: D1Database,
  feed: CrawlTarget,
  options: FullTextOptions,
): Promise<FullTextResult> {
  const budget = options.budget;

  if (!feed.fullText) return { filled: [] };

  // 取りに行く前に枠を確保する（fetch.ts の reserveBudget）
  const limit = reserveBudget(budget, MAX_ARTICLES_PER_FEED);
  if (limit === 0) return { filled: [] };

  const targets = await selectMissingFullText(db, feed.id, limit);
  // 取りに行かなかった分だけ返す。**取りに行って失敗した分は返さない。**
  // 記事 URL が全滅しているフィード（サイト移転）で毎回 10 件ずつ叩き続けると、
  // サブリクエスト上限に当たる
  releaseBudget(budget, limit - targets.length);
  if (targets.length === 0) return { filled: [] };

  const { pages, gone } = await fetchArticles(targets, options.fetchImpl);
  // 記事ページが消えている（404 / 410）ものには印を残す。残さないと、サイト移転で
  // URL が全滅したフィードの同じ 10 件を 15 分ごとに叩き続けることになる。
  // 一時的な失敗（打ち切り・5xx・接続断）は印を付けず、次の機会に回す
  if (gone.length > 0) await markTried(db, gone);
  if (pages.length === 0) return { filled: [] };

  let selector = feed.fullTextSelector;
  if (selector === null) {
    selector = await decideSelector(db, feed.id, pages[0].html, options.ai);
    // 本文らしい入れ物が 1 つも無いページだった（JavaScript で描くサイト等）。
    // 取りに行った記事には印を残す。残さないと毎クロール同じ記事を叩き続ける
    if (selector === null) {
      await markTried(
        db,
        pages.map((page) => page.target.id),
      );
      return { filled: [] };
    }
  }

  let extraction = await extractAll(pages, selector);

  // **覚えていたセレクタがどの記事にも当たらなくなったときだけ**判定し直す。
  // サイトが作り替えられた場合にあたる。「当たったが短くて採らなかった」を
  // 混ぜてはいけない。混ぜると、採れない記事が続く限り毎クロール AI を呼び、
  // 正しかったかもしれないセレクタを上書きし続ける（判定はフィードにつき 1 回）
  if (extraction.unmatched.length === pages.length && feed.fullTextSelector !== null) {
    const rechosen = await decideSelector(db, feed.id, pages[0].html, options.ai);
    if (rechosen !== null && rechosen !== selector) {
      selector = rechosen;
      // 前のセレクタで採れなかった記事も、新しいセレクタなら採れるかもしれない
      await clearRejectedFullText(db, feed.id);
      // 取り直しはしないので、余分な取得は増えない
      extraction = await extractAll(pages, selector);
    }
  }

  // **埋め込みの解決は、抽出が確定してから 1 回だけ。** 抽出の中でやると、
  // セレクタを判定し直したときの再抽出でもう一度 X に問い合わせることになる
  // （記事ページは取り直さないのに、埋め込みだけ二重に取りに行ってしまう）
  for (const body of extraction.bodies) {
    body.fullBody = await resolveTweetEmbeds(body.fullBody, options);
  }

  // 採らなかった記事にも印を残す。残さないと毎クロール同じ記事を取りに行く。
  // **セレクタが当たらなかったものも同じ。** 判定し直しても同じ答えになる場合
  // （再判定で選び直せなかった / 同じセレクタが返った）に取り直しが止まらなくなる。
  // 印は本文の位置を判定し直したときに消えるので、後から拾い直す道は残る
  await updateFullBodies(db, [
    ...extraction.bodies,
    ...[...extraction.rejected, ...extraction.unmatched].map((id) => ({ id, fullBody: '' })),
  ]);
  return { filled: extraction.bodies.map((body) => body.id) };
}

/** 「取りに行ったが採らなかった」印だけを付ける（migrations/0003_full_text.sql） */
function markTried(db: D1Database, entryIds: number[]): Promise<void> {
  return updateFullBodies(
    db,
    entryIds.map((id) => ({ id, fullBody: '' })),
  );
}

interface ArticlePage {
  target: FullTextTarget;
  html: string;
}

/**
 * 記事ページを取ってくる。
 *
 * 取れなかったものは「二度と取れない（gone）」と「今回は駄目だった」に分ける。
 * 前者には印を残して取り直しを止め、後者は次の機会に回す。
 */
async function fetchArticles(
  targets: FullTextTarget[],
  fetchImpl: typeof fetch,
): Promise<{ pages: ArticlePage[]; gone: number[] }> {
  const pages: ArticlePage[] = [];
  const gone: number[] = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (target) => ({ target, outcome: await fetchArticle(target.url, fetchImpl) })),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { target, outcome } = result.value;
      if (outcome.kind === 'ok') pages.push({ target, html: outcome.html });
      else if (outcome.kind === 'gone') gone.push(target.id);
    }
  }
  return { pages, gone };
}

type ArticleOutcome =
  | { kind: 'ok'; html: string }
  /** 記事ページが消えている。取り直しても結果は変わらない */
  | { kind: 'gone' }
  /** 一時的な失敗。次の機会に回す */
  | { kind: 'retry' };

async function fetchArticle(url: string, fetchImpl: typeof fetch): Promise<ArticleOutcome> {
  // 条件付き GET は使わない。記事ページは 1 度しか取りに行かないので、
  // etag を覚えておく先も、覚えておく意味も無い
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // 記事 1 本が取れなくてもフィードの取得は成功している。
    // feeds.last_error に書くとフィード自体が壊れているように見えるので書かない
    console.warn('全文の取得に失敗', url, describeNetworkError(err).message);
    return { kind: 'retry' };
  }
  // 404 / 410 は何度引いても同じ。それ以外（5xx や 429）は時間を置けば直りうる
  if (response.status === 404 || response.status === 410) return { kind: 'gone' };
  if (!response.ok) return { kind: 'retry' };

  const read = await readBoundedText(response);
  return read.kind === 'ok' ? { kind: 'ok', html: read.body } : { kind: 'retry' };
}

/**
 * 記事ページのどこが本文かを決めて覚える。
 * 決められなければ null を返し、次の取得で改めて試す。
 */
async function decideSelector(
  db: D1Database,
  feedId: number,
  html: string,
  ai: Ai | undefined,
): Promise<string | null> {
  const candidates = await scanCandidates(html);
  const chosen = await chooseBodySelector(candidates, ai);
  if (chosen === null) return null;

  await updateFullTextSelector(db, feedId, chosen.selector, chosen.source);
  return chosen.selector;
}

interface Extraction {
  bodies: { id: number; fullBody: string }[];
  /** セレクタは当たったが採らなかった記事。取り直さないよう印を付ける */
  rejected: number[];
  /** セレクタがどこにも当たらなかった記事。判定し直すかどうかの材料になる */
  unmatched: number[];
}

/**
 * 取れたページから本文を抜く。
 *
 * **フィードが配信した本文より短いものは採らない。** 抽出が外れたときは、
 * 注釈やパンくずだけを掴んで「本文が数十字になる」形で失敗する。それを書き込むと、
 * 全文取得を入れたせいで読めるものが減る。
 *
 * 「当たらなかった」と「当たったが採らなかった」を分けて返す。前者はサイトの
 * 作り替えを疑う材料で、後者は判定し直しても直らない（同じ記事が短いだけ）。
 */
async function extractAll(pages: ArticlePage[], selector: string): Promise<Extraction> {
  const extraction: Extraction = { bodies: [], rejected: [], unmatched: [] };

  for (const page of pages) {
    const fullBody = await sanitizeWithin(page.html, selector, page.target.url);
    if (fullBody === null) {
      extraction.unmatched.push(page.target.id);
    } else if (fullBody.length <= page.target.bodyLength) {
      extraction.rejected.push(page.target.id);
    } else {
      extraction.bodies.push({ id: page.target.id, fullBody });
    }
  }
  return extraction;
}

/**
 * このフィードは要約しか配信していないか。購読管理画面で全文取得を勧めるのに使う。
 *
 * 見るのは中央値。1 本だけ長い記事があるフィード（本文を配るときと配らないときが
 * 混ざるサイト）に引きずられないようにするため。
 */
export function looksSummaryOnly(bodies: { body: string; url: string | null }[]): boolean {
  // 数本では傾向と言えない。連載の谷間で 1 本だけ短い、といった揺れを拾ってしまう
  if (bodies.length < 3) return false;
  // 記事ページの URL が無ければ取りに行きようがない
  if (bodies.some((entry) => entry.url === null)) return false;

  const lengths = bodies.map((entry) => entry.body.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  return median < SUMMARY_LENGTH;
}

/**
 * これを下回れば要約とみなす長さ。
 * テクノエッジの配信は 100 字前後、本文は 4000 字を超える（extract.test.ts）ので、
 * その間ならどこで切っても同じ。全文を配るフィードを巻き込まない側に寄せてある。
 */
const SUMMARY_LENGTH = 500;
