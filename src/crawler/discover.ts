import { describeNetworkError, readBoundedText, TIMEOUT_MS, USER_AGENT } from './fetch';
import { parseFeed } from './parse';

/**
 * フィードの自動検出（docs/API.md の POST /api/feeds）。
 *
 * ユーザが渡すのはサイトの URL であることの方が多い。まず渡された URL 自体を
 * 取りに行き、フィードとして読めればそれを使う。読めなければ HTML とみなして
 * <link rel="alternate"> を拾う。
 *
 * HTML の解析は HTMLRewriter で行う。Workers に DOMParser は無く、
 * HTMLRewriter は HTML 専用（RSS のパースには使わない。CLAUDE.md）。
 */

// 名乗りと上限・打ち切りは取得側（fetch.ts）と共有する。
// Accept だけはここ専用。渡されるのがサイトの URL のこともあるので HTML も受ける
const ACCEPT =
  'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

/**
 * `<a href>` がフィードを指していそうなパス。`<a>` を絞り込むのに使う。
 * ここを通っても最後にホスト名と否定リストで確かめる
 */
const FEED_PATH = /(\.(xml|rdf|atom|rss)|\/(feeds?|rss|atom)\/?)$/i;

/** そもそも見る価値のある href か。URL を組む前の安い足切り */
const MAYBE_FEED = /(xml|rdf|atom|rss|feed)/i;

/** 拡張子が .xml でもフィードではないもの */
const NOT_FEED = /(sitemap|opensearch|manifest|atomsvc)/i;

/** フィードとして扱う type 属性。大文字小文字は無視する */
const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/xml',
  'text/xml',
]);

export interface FeedCandidate {
  url: string;
  /** <link> の title 属性。フィードを取りに行くまで名前が分からないことがある */
  title: string | null;
}

export type DiscoverResult =
  /** 渡された URL 自体がフィードだった */
  | { kind: 'feed'; url: string; title: string; siteUrl: string | null }
  /** HTML から見つかった候補。0 件なら候補無しとして呼び出し側が 404 にする */
  | { kind: 'candidates'; candidates: FeedCandidate[] }
  | { kind: 'error'; message: string };

export async function discoverFeed(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'error', message: describeNetworkError(err).message };
  }

  if (!response.ok) {
    return { kind: 'error', message: `HTTP ${response.status} ${response.statusText}`.trim() };
  }

  const read = await readBoundedText(response);
  if (read.kind === 'error') return { kind: 'error', message: read.message };
  const body = read.body;

  // リダイレクトの後の URL を基準にする。相対 href の解決先がずれないように
  const baseUrl = response.url === '' ? url : response.url;

  try {
    const parsed = parseFeed(body);
    return { kind: 'feed', url: baseUrl, title: parsed.title, siteUrl: parsed.siteUrl };
  } catch {
    // フィードとして読めなかった。HTML とみなして候補を探す
  }

  return { kind: 'candidates', candidates: await extractCandidates(body, baseUrl) };
}

/**
 * <link rel="alternate" type="application/rss+xml" href="..."> を集める。
 *
 * 同じ URL が複数回出てくるサイトがあるので、URL で重複を除く。
 * 順序は HTML に現れた順のまま返す（サイトが上に置いたものが主フィードであることが多い）。
 *
 * **`<link>` が 1 つも無ければ `<a href>` に落ちる。** 自動検出用のタグを出さず、
 * 人間向けのリンクだけを置くサイトがある。落ちるのは 0 件のときだけで、
 * `<link>` があるサイトの候補に紛れ込ませない（そちらの方が確かなので）。
 */
async function extractCandidates(html: string, baseUrl: string): Promise<FeedCandidate[]> {
  const found = new Map<string, FeedCandidate>();
  const fallback = new Map<string, FeedCandidate>();
  // <a> ごとに組み直さない。走査の間ずっと同じもの。
  // hash は相対 URL の解決に使われないので、先に落としておけば
  // 「ページ自身へのリンクか」の比較がそのまま行える
  const base = new URL(baseUrl);
  base.hash = '';

  const rewriter = new HTMLRewriter()
    .on('link', {
      element(element) {
        const rel = element.getAttribute('rel')?.toLowerCase() ?? '';
        // rel は空白区切りで複数取りうる（rel="alternate home"）
        if (!rel.split(/\s+/).includes('alternate')) return;

        const type = element.getAttribute('type')?.toLowerCase().trim() ?? '';
        if (!FEED_TYPES.has(type)) return;

        const href = element.getAttribute('href');
        if (href === null) return;

        const absolute = absoluteUrl(href, baseUrl);
        if (absolute === null || found.has(absolute)) return;
        found.set(absolute, { url: absolute, title: element.getAttribute('title') });
      },
    })
    .on('a', {
      element(element) {
        // <link> は <head>、<a> は <body> にあるので、ここへ来る時点で答えは出ている。
        // 見つかっていれば fallback は最後に捨てられるので、数える必要が無い
        if (found.size > 0) return;

        const href = element.getAttribute('href');
        // 記事一覧のページには <a> が数百ある。URL を組む前に安く落とす
        if (href === null || !MAYBE_FEED.test(href)) return;

        const absolute = feedLikeUrl(href, base);
        if (absolute === null) return;
        // 名前はフィード自身の名乗りに任せる（<a> の文字は「RSS」等の総称が多い）
        fallback.set(absolute, { url: absolute, title: null });
      },
    });

  // 変換後の本文は使わない。読み切らないとハンドラが最後まで走らないので捨てるために読む
  await rewriter.transform(new Response(html)).text();
  return found.size > 0 ? [...found.values()] : [...fallback.values()];
}

/**
 * `<a href>` がフィードを指していそうか。指していれば絶対 URL、違えば null。
 *
 * **同じサイトの中だけを見る。** 外部の購読サービス（feedly など）へのリンクが
 * 混ざると、そちらを購読してしまう。候補が 1 つなら確認せずに購読する経路がある
 * ので（api/feeds.ts）、迷うものは候補にしない。
 */
function feedLikeUrl(href: string, base: URL): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }

  // **ホスト名で見る。** origin の完全一致にすると、www の有無や http のままの
  // 絶対 URL を書いているサイトのリンクを落とす。外部の購読サービスを弾くのが
  // 目的なので、同じサイトかどうかが分かれば足りる
  if (siteName(url) !== siteName(base)) return null;
  if (NOT_FEED.test(url.pathname)) return null;
  if (!FEED_PATH.test(url.pathname)) return null;

  // <a> には目印や計測用の付け足しが付く。同じフィードが別々の候補になると、
  // 見た目の同じ選択肢をユーザに見せることになる
  url.hash = '';
  // ページ自身へのリンク（<a href="#main">）は候補にしない
  return url.href === base.href ? null : url.href;
}

/** www の有無を無視したホスト名。同じサイトかどうかの判定に使う */
function siteName(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}
