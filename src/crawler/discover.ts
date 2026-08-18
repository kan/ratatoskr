import { errorMessage } from '../lib/errors';
import { readBoundedText, TIMEOUT_MS, USER_AGENT } from './fetch';
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
    return { kind: 'error', message: `取得に失敗: ${errorMessage(err)}` };
  }

  if (!response.ok) {
    return { kind: 'error', message: `HTTP ${response.status} ${response.statusText}`.trim() };
  }

  const read = await readBoundedText(response);
  if (read.kind === 'error') return read;
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
 */
async function extractCandidates(html: string, baseUrl: string): Promise<FeedCandidate[]> {
  const found = new Map<string, FeedCandidate>();

  const rewriter = new HTMLRewriter().on('link', {
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
  });

  // 変換後の本文は使わない。読み切らないとハンドラが最後まで走らないので捨てるために読む
  await rewriter.transform(new Response(html)).text();
  return [...found.values()];
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}
