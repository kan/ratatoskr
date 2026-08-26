import {
  DISCOVER_ANCESTOR_BUDGET_MS,
  describeNetworkError,
  readBoundedText,
  TIMEOUT_MS,
  USER_AGENT,
} from './fetch';
import { parseFeed } from './parse';

/**
 * フィードの自動検出（docs/API.md の POST /api/feeds）。
 *
 * ユーザが渡すのはサイトの URL であることの方が多い。まず渡された URL 自体を
 * 取りに行き、フィードとして読めればそれを使う。読めなければ HTML とみなして
 * <link rel="alternate"> を拾う。
 *
 * **見つからなければ、パスを 1 段ずつ遡って同じことを試す。** 記事詳細ページに
 * フィードの在処を書いていないサイトがある（note は記事ページに
 * `<link rel="alternate">` を置かない）。上の階層まで推測するだけで、
 * `/feed` `/rss.xml` のようなファイル名は推測しない（docs/ROADMAP.md）。
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

/** 1 回ぶんの検出。遡りの起点にするため、リダイレクトの後の URL も持つ */
interface Attempt {
  result: DiscoverResult;
  /** 実際に見に行ったページ。相対 href の解決先でもある */
  pageUrl: string;
}

/** 検出の結果と、それをどこで見つけたか */
export interface Discovery extends Attempt {
  /**
   * 貼られたページではなく、**上の階層で見つけた**か。
   *
   * 呼び出し側は、これが立っていたら候補が 1 件でも、フィードそのものでも
   * 確認を挟む（api/feeds.ts）。貼られた URL と違う場所のフィードなので、
   * 黙って登録すると「頼んでいないものが増えた」形になる
   */
  viaAncestor: boolean;
}

/**
 * 遡るパスの段数。購読の追加は対話的な操作なので数回の取得は許容範囲だが、
 * 深い URL で無制限に叩かない。note（`/user/n/id` → `/user`）は 2 段で届く
 */
const MAX_ANCESTORS = 3;

export async function discoverFeed(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Discovery> {
  const first = await discoverAt(url, fetchImpl, AbortSignal.timeout(TIMEOUT_MS));
  // **遡るのは「取れたが候補が 0 件」のときだけ。** 404 や接続の失敗は、
  // 何が起きたかをそのまま返す方が直しようがある
  if (first.result.kind !== 'candidates' || first.result.candidates.length > 0) {
    return { ...first, viaAncestor: false };
  }

  // **締め切りは遡り全体で 1 つ。** 段ごとに持たせると、全滅したときに段数ぶん
  // 積み上がる。過ぎた後の段は投げた時点で落ちるので、待ちはここで頭打ちになる
  const deadline = AbortSignal.timeout(DISCOVER_ANCESTOR_BUDGET_MS);
  // 見に行った先を覚えておく。「未知のパスは全部トップへ転送」の作りだと、
  // 段が違っても同じページに落ち着くので、二度引いても答えは変わらない
  const seen = new Set([url, first.pageUrl]);

  // **遡る起点はリダイレクトの後。** 短縮 URL を貼られたとき、元の URL から
  // 遡ると短縮サービスのトップページを叩きに行くことになる
  for (const parent of ancestors(first.pageUrl)) {
    if (seen.has(parent)) continue;
    const found = await discoverAt(parent, fetchImpl, deadline);
    if (seen.has(found.pageUrl)) continue;
    seen.add(found.pageUrl);

    const { result } = found;
    const hit =
      result.kind === 'feed' || (result.kind === 'candidates' && result.candidates.length > 0);
    if (hit) return { ...found, viaAncestor: true };
  }
  return { ...first, viaAncestor: false };
}

/**
 * 貼られた URL から見た上の階層。近い順に最大 MAX_ANCESTORS 件。
 *
 * クエリとフラグメントは落とす。記事を指す目印なので、上の階層には持ち上がらない。
 * 末尾がディレクトリの形（`/a/b/`）なら、まず `/a/` を見る
 */
function ancestors(url: string): string[] {
  // ここに来る URL は api/feeds.ts で正規化済みか、fetch が返した response.url。
  // どちらも組み立て済みなので、壊れた形は来ない
  const base = new URL(url);
  base.search = '';
  base.hash = '';

  const found: string[] = [];
  // 空要素は末尾スラッシュのぶん。落として数え直す
  const parts = base.pathname.split('/').filter((part) => part !== '');
  for (let depth = parts.length - 1; depth >= 0 && found.length < MAX_ANCESTORS; depth -= 1) {
    base.pathname = `${parts
      .slice(0, depth)
      .map((part) => `/${part}`)
      .join('')}/`;
    found.push(base.href);
  }
  return found;
}

async function discoverAt(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Attempt> {
  const fail = (message: string): Attempt => ({ result: { kind: 'error', message }, pageUrl: url });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT },
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    return fail(describeNetworkError(err).message);
  }

  if (!response.ok) return fail(`HTTP ${response.status} ${response.statusText}`.trim());

  const read = await readBoundedText(response);
  if (read.kind === 'error') return fail(read.message);
  const body = read.body;

  // リダイレクトの後の URL を基準にする。相対 href の解決先がずれないように
  const pageUrl = response.url === '' ? url : response.url;

  // **HTML と名乗っているものを XML として読もうとしない。** 遡り先は索引ページ
  // なのでまず外れるうえ、readBoundedText は 4MB まで読むので、その全文を
  // fast-xml-parser に通す時間が段の数だけ積み上がる（CPU 時間は計上される）
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('xhtml')) {
    try {
      const parsed = parseFeed(body);
      return {
        result: { kind: 'feed', url: pageUrl, title: parsed.title, siteUrl: parsed.siteUrl },
        pageUrl,
      };
    } catch {
      // フィードとして読めなかった。HTML とみなして候補を探す
    }
  }

  return {
    result: { kind: 'candidates', candidates: await extractCandidates(body, pageUrl) },
    pageUrl,
  };
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
