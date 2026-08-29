import {
  clearRejectedFullText,
  selectMissingFullText,
  updateFullBodies,
  type FullTextTarget,
} from '../db/entries';
import { updateFullTextSelector, type CrawlTarget } from '../db/feeds';
import { chooseBodySelector, type BodySelector } from './choose';
import { resolveTweetEmbeds } from './embed';
import {
  type Candidate,
  fragmentOf,
  locateFragmentOccurrence,
  pageUrlOf,
  scanCandidates,
} from './extract';
import { bodiesCollapsed, repeatedSignatures } from './repeat';
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

/**
 * 本文の位置を決めるのに走査するページ数。
 *
 * 1 本目がリンクだけの記事でも 2〜3 本見れば外れる。全件試すと、候補が永久に
 * 出ないサイト（JavaScript で描くサイト）で毎クロール 10 ページ分を走査し続ける。
 *
 * **3 は「繰り返しを見つけるのに要る数」でもある。** 別々のページを突き合わせて
 * 初めて外枠が分かるので（src/crawler/repeat.ts）、1 ページで打ち切ると信号が無い
 */
const MAX_SELECTOR_TRIALS = 3;

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
  // サブリクエスト上限に当たる。
  //
  // **返すのは記事数の分で、ページ数の分ではない。** 同じページを指す記事は 1 回しか
  // 取りに行かないが、そこで返してしまうと予算が抽出の量を縛らなくなる（1 ページに
  // 10 記事載るフィードが 20 本あれば 200 記事分の走査が通ってしまう）
  releaseBudget(budget, limit - targets.length);
  if (targets.length === 0) return { filled: [] };

  const { pages, gone } = await fetchArticles(targets, options.fetchImpl);
  // 記事ページが消えている（404 / 410）ものには印を残す。残さないと、サイト移転で
  // URL が全滅したフィードの同じ 10 件を 15 分ごとに叩き続けることになる。
  // 一時的な失敗（打ち切り・5xx・接続断）は印を付けず、次の機会に回す
  if (pages.length === 0) {
    await markTried(db, gone);
    return { filled: [] };
  }

  // **覚えていたセレクタと、このクロールで決めたセレクタを分けて持つ。** 決めた方は
  // 抽出で確かめるまで保存しない（外枠を掴んでいたと分かってから取り消すより、
  // 初めから保存しない方が状態が 1 つ減る）
  const remembered = feed.fullTextSelector;
  let chosen: BodySelector | null = null;
  let selector = remembered;
  if (selector === null) {
    chosen = await chooseSelector(pages, options.ai);
    // 本文らしい入れ物が 1 つも無いページだった（JavaScript で描くサイト等）。
    // 取りに行った記事には印を残す。残さないと毎クロール同じ記事を叩き続ける
    if (chosen === null) {
      await markTried(db, [...gone, ...pages.map((page) => page.target.id)]);
      return { filled: [] };
    }
    selector = chosen.selector;
  }

  let extraction = await extractAll(pages, selector);

  // **覚えていたセレクタが用を成さなくなったときだけ**判定し直す。当たるものが
  // 1 つも無くなった（サイトの作り替え）か、どの記事も同じ本文になった
  // （外枠を掴んでいる）場合にあたる。「当たったが短くて採らなかった」を
  // 混ぜてはいけない。混ぜると、採れない記事が続く限り毎クロール AI を呼び、
  // 正しかったかもしれないセレクタを上書きし続ける（判定はフィードにつき 1 回）。
  //
  // このクロールで決めたばかりのセレクタ（chosen）は対象にしない。同じ材料で
  // 決め直しても同じ答えになるだけで、走査を 1 回増やすことにしかならない
  if (chosen === null && (extraction.unmatched.length === pages.length || extraction.collapsed)) {
    const rechosen = await chooseSelector(pages, options.ai);
    if (rechosen !== null && rechosen.selector !== selector) {
      chosen = rechosen;
      selector = rechosen.selector;
      // 取り直しはしないので、余分な取得は増えない
      extraction = await extractAll(pages, selector);
    }
  }

  if (extraction.collapsed) {
    // **外枠を指していると分かった。** 決めたばかりなら保存しない。覚えていたものなら
    // 捨てる（残すと次のクロールでも同じ外枠を全記事の本文として保存し続ける）。
    // 文章のある記事が入った回に決め直せるようになるが、この回の記事には下で
    // 「取りに行ったが採らなかった」印が付くので、何度も取りに行くことにはならない
    if (remembered !== null) await updateFullTextSelector(db, feed.id, null, null);
  } else if (chosen !== null) {
    await updateFullTextSelector(db, feed.id, chosen.selector, chosen.source);
    // 本文の位置が変わった。前に「取りに行ったが採らなかった」で印を付けた記事も
    // 今度は採れるかもしれないので、印を消して次のクロールで拾い直させる
    await clearRejectedFullText(db, feed.id);
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
  // 印は本文の位置を判定し直したときに消えるので、後から拾い直す道は残る。
  //
  // **消えた記事ページの印も同じ書き込みで付ける。** 上の clearRejectedFullText は
  // このフィードの印を区別せずに消すので、先に付けても巻き添えになる
  await updateFullBodies(db, [
    ...extraction.bodies,
    ...[...extraction.rejected, ...extraction.unmatched, ...gone].map((id) => ({
      id,
      fullBody: '',
    })),
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
  /**
   * フラグメントを落とした取得先。**どの記事が同じページのものかを表す。**
   * `fetchArticles` が取得をまとめるのに使った区切りをそのまま下流へ渡す
   * （繰り返しの判定は別々のページの間だけで意味を持つので、毎回 URL から
   * 導き直すと同じ規則が何か所にも散る）
   */
  pageUrl: string;
}

/**
 * 記事ページを取ってくる。
 *
 * **同じページを指す記事はまとめて 1 回だけ取る。** 日記型のサイトでは 1 ページに
 * 1 か月分の記事が並び、記事 URL はフラグメントだけが違う。記事ごとに取りに行くと、
 * 同じ 75KB を 1 回のクロールで 10 回引くことになり、相手のサーバへの礼儀にも
 * サブリクエスト上限にも反する。
 *
 * 取れなかったものは「二度と取れない（gone）」と「今回は駄目だった」に分ける。
 * 前者には印を残して取り直しを止め、後者は次の機会に回す。
 */
async function fetchArticles(
  targets: FullTextTarget[],
  fetchImpl: typeof fetch,
): Promise<{ pages: ArticlePage[]; gone: number[] }> {
  const byPage = new Map<string, FullTextTarget[]>();
  for (const target of targets) {
    const url = pageUrlOf(target.url);
    const group = byPage.get(url);
    if (group === undefined) byPage.set(url, [target]);
    else group.push(target);
  }

  const pages: ArticlePage[] = [];
  const gone: number[] = [];
  const urls = [...byPage.keys()];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (url) => ({ url, outcome: await fetchArticle(url, fetchImpl) })),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { url, outcome } = result.value;
      const group = byPage.get(url) ?? [];
      if (outcome.kind === 'ok') {
        for (const target of group) pages.push({ target, html: outcome.html, pageUrl: url });
      } else if (outcome.kind === 'gone') {
        for (const target of group) gone.push(target.id);
      }
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
 * 記事ページのどこが本文かを決める。決められなければ null。
 *
 * **保存はしない。** 決めたセレクタが正しいかどうかは、それで抜いてみるまで
 * 分からない（どの記事も同じ本文になれば外枠を掴んでいる）ので、確かめた側で保存する。
 *
 * **1 本目で決めない。** 候補が出るまで取れたページを順に試す。日記型のサイトには
 * リンクと画像だけの記事が普通に混ざっていて、それに当たると段落が 0 になり候補が
 * 出ない。1 本目だけを見ていると、その回に取れた 10 件すべてを諦めることになる。
 *
 * **複数のページを突き合わせてから決める。** どのページにも同じ文章で出てくる
 * 塊は本文ではないので、候補から外す（src/crawler/repeat.ts）。朝日新聞の記事
 * ページでは著作権表記が本文を抜いて 1 位になることがあり、外さないと点数だけでは
 * それを選ぶ（実測）。
 */
async function chooseSelector(
  pages: ArticlePage[],
  ai: Ai | undefined,
): Promise<BodySelector | null> {
  const { ordered, distinct } = trialOrder(pages);
  // 絞らない側の走査はページにしか依らないので、同じページでは 1 回で済ませる
  const whole = new Map<string, Candidate[]>();

  const trials: Candidate[][] = [];
  for (const page of ordered.slice(0, MAX_SELECTOR_TRIALS)) {
    trials.push(await candidatesFor(page, whole));
  }

  // **繰り返しを数えるのは別々のページの間だけ。** 1 ページに 1 か月分が並ぶ
  // 日記型のサイトでは複数の記事が同じ HTML を指すので、そのまま数えると同じ
  // ページを 3 回見て「どのページにも出る」と誤って判定する。別々のページは
  // trialOrder が先頭に寄せてある
  const repeated = repeatedSignatures(trials.slice(0, distinct));

  for (const candidates of trials) {
    const kept = candidates.filter((candidate) => !repeated.has(candidate.signature));
    const chosen = await chooseBodySelector(kept, ai);
    if (chosen !== null) return chosen;
  }
  return null;
}

/**
 * 試す順。**別々のページを先に並べ、その本数を添えて返す。**
 *
 * 見るのは先頭の MAX_SELECTOR_TRIALS 件だけなので、並べ替えないと日記型のサイトで
 * 同じページばかり 3 回見ることになり、繰り返しの信号が取れない。同じページの
 * 別の記事も後ろに残す。1 本目がリンクだけの記事だったときに、そこで諦めずに
 * 隣の記事で決められるのはこれがあるため。
 *
 * 別々のページが**先頭から distinct 件**になるので、繰り返しを数える側は
 * 同じ判定をやり直さずに済む。
 */
function trialOrder(pages: ArticlePage[]): { ordered: ArticlePage[]; distinct: number } {
  const seen = new Set<string>();
  const first: ArticlePage[] = [];
  const rest: ArticlePage[] = [];
  for (const page of pages) {
    if (seen.has(page.pageUrl)) rest.push(page);
    else {
      seen.add(page.pageUrl);
      first.push(page);
    }
  }
  return { ordered: [...first, ...rest], distinct: first.length };
}

/**
 * 1 ページ分の候補。**フラグメントで絞った場合と絞らない場合の両方を採点して、
 * 点の高い方を採る。**
 *
 * 絞るのが常に正しいとは限らない。記事 URL の `#` は記事を指すとは限らず、
 * `#comments` のようにページの一部を指すこともある。その場合に絞ると、本文が
 * 候補から消えてコメント欄が選ばれる。点数は同じ尺度（段落の量をリンク率で
 * 割り引いたもの）なので、そのまま比べられる。
 */
async function candidatesFor(
  page: ArticlePage,
  whole: Map<string, Candidate[]>,
): Promise<Candidate[]> {
  const fragment = fragmentOf(page.target.url);
  if (fragment === null) return await wholePage(page, whole);

  const scoped = await scanCandidates(page.html, { fragment });
  // **絞った先に文章が無いことと、ページに本文が無いことは別物。** 前者で
  // ページ全体に落とすと、リンクだけの記事に当たった回にページの外枠を
  // セレクタとして覚えてしまう。この記事では決めず、次のページに回す
  if (scoped.length === 0) return [];

  const unscoped = await wholePage(page, whole);
  return scoped[0].score > (unscoped[0]?.score ?? 0) ? scoped : unscoped;
}

/**
 * 絞らずに走査した候補。**同じページでは 1 回しか走査しない。**
 *
 * 日記型のサイトでは 3 回の試行が同じ HTML になることがあり、絞らない側は
 * 記事によらず同じ結果になる。走査は 4MB までのページに対するフルパスなので、
 * そのまま回すと同じ仕事を 3 回する
 */
async function wholePage(page: ArticlePage, memo: Map<string, Candidate[]>): Promise<Candidate[]> {
  const cached = memo.get(page.pageUrl);
  if (cached !== undefined) return cached;

  const candidates = await scanCandidates(page.html);
  memo.set(page.pageUrl, candidates);
  return candidates;
}

interface Extraction {
  bodies: { id: number; fullBody: string }[];
  /** セレクタは当たったが採らなかった記事。取り直さないよう印を付ける */
  rejected: number[];
  /** セレクタがどこにも当たらなかった記事。判定し直すかどうかの材料になる */
  unmatched: number[];
  /**
   * どの記事も同じ本文になった。**セレクタが外枠を指している証拠**なので、
   * 抜けたもの（bodies）は 1 件も採らず、unmatched と同じく判定し直す材料にする
   * （src/crawler/repeat.ts）
   */
  collapsed: boolean;
}

/**
 * 取れたページから本文を抜く。
 *
 * **フィードが配信した本文より短いものは採らない。** 抽出が外れたときは、
 * 注釈やパンくずだけを掴んで「本文が数十字になる」形で失敗する。それを書き込むと、
 * 全文取得を入れたせいで読めるものが減る。
 *
 * **別々の記事から同じ本文が出てきたら、どちらも採らない。** それはセレクタが
 * 本文ではなく外枠を指しているということで、長さでも点数でも表に出ない
 * （結城浩の日記は全 15 件の全文が同じ著者プロフィールになっていた）。
 *
 * 「当たらなかった」「当たったが採らなかった」「別の記事と同じだった」を分けて
 * 返す。1 つ目と 3 つ目はサイトの作り替え・判定の誤りを疑う材料で、2 つ目は
 * 判定し直しても直らない（同じ記事が短いだけ）。
 */
async function extractAll(pages: ArticlePage[], selector: string): Promise<Extraction> {
  const rejected: number[] = [];
  const unmatched: number[] = [];
  const extracted: { id: number; url: string; fullBody: string }[] = [];

  for (const page of pages) {
    const fullBody = await sanitizeWithin(
      page.html,
      selector,
      page.target.url,
      await occurrenceFor(page, selector),
    );
    if (fullBody === null) unmatched.push(page.target.id);
    else if (fullBody.length <= page.target.bodyLength) rejected.push(page.target.id);
    else extracted.push({ id: page.target.id, url: page.target.url, fullBody });
  }

  // 外枠を掴んでいると分かったなら、抜けたものは 1 件残らず外枠。1 件でも採ると、
  // 防ぎたかった「外枠が本文として保存される」がその回に限って通る
  const collapsed = bodiesCollapsed(extracted);
  return {
    bodies: collapsed ? [] : extracted.map(({ id, fullBody }) => ({ id, fullBody })),
    rejected: collapsed ? [...rejected, ...extracted.map((body) => body.id)] : rejected,
    unmatched,
    collapsed,
  };
}

/**
 * 覚えたセレクタに当たるもののうち、この記事のものは何番目か。
 *
 * **1 ページに複数の記事が並ぶ日記型のサイトのため。** 記事 URL のフラグメントが
 * どの記事かを決めるので、それが無いページでは常に最初の 1 つ（0）になり、
 * 従来と同じ動きをする。
 */
async function occurrenceFor(page: ArticlePage, selector: string): Promise<number> {
  const fragment = fragmentOf(page.target.url);
  if (fragment === null) return 0;
  return (await locateFragmentOccurrence(page.html, selector, fragment)) ?? 0;
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
