import {
  describeNetworkError,
  releaseBudget,
  reserveBudget,
  TIMEOUT_MS,
  USER_AGENT,
  type FetchBudget,
} from './fetch';
import { sanitizeHtml } from './sanitize';

/**
 * 記事に埋め込まれた X のポストを、読める形にする。
 *
 * **本文はそもそも記事ページに入っていない。** サイトが置くのは
 * `<blockquote class="twitter-tweet"><a href="…/status/123"></a></blockquote>` だけで、
 * 中身は X の widgets.js がブラウザで取りに行く（テクノエッジの実装を確認した）。
 * こちらはスクリプトを通さないので、そのままでは**空の引用**が残り、記事によっては
 * 話が繋がらなくなる。
 *
 * そこで取り込み時に oEmbed（publish.x.com）を引いて、本文・投稿者・日時を
 * 引用として埋め込む。認証は要らない。返ってきた HTML は必ずサニタイズを通す
 * （CLAUDE.md の不変条件 4）。
 *
 * 引けなかったときの扱いは resolveTweetEmbeds を参照。
 */

const OEMBED_ENDPOINT = 'https://publish.x.com/oembed';

/** 同時に引く数。相手のサーバに配慮して広げない */
const CONCURRENCY = 2;

/** 1 記事から引く埋め込みの上限。1 本の記事で予算を使い切らせない */
const MAX_PER_ENTRY = 4;

const TWEET_STATUS = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([^/?#]+)\/status\/(\d+)/;

/**
 * oEmbed に渡す形に直す。
 *
 * 記事に貼られる URL には `?s=20` が付いていたり、`/video/1` `/photo/2` のように
 * ポストの中の 1 枚を指していたりする。**そのままでは oEmbed が受け付けない**
 * （実際にテクノエッジの `/video/1` 付きが弾かれた）。投稿者と id だけに削る。
 */
function canonicalTweetUrl(url: string): string | null {
  const match = TWEET_STATUS.exec(url);
  return match === null ? null : `https://x.com/${match[1]}/status/${match[2]}`;
}

export interface EmbedOptions {
  fetchImpl: typeof fetch;
  budget: FetchBudget;
}

/**
 * 解決すべき埋め込みがありそうか。**本文を走査する前の足切り。**
 * 埋め込みを含む記事はごく一部なので、含まないことが文字列で分かる大多数について、
 * 走査も DB 参照も省く。
 */
export function mayHaveTweetEmbed(html: string): boolean {
  return html.includes('/status/') && html.includes('<blockquote');
}

/**
 * サニタイズ済みの本文から、空になっている X の埋め込みを読める形に直す。
 * 直すものが無ければ受け取った本文をそのまま返す。
 *
 * **引けなかったものは空の引用のまま残す。** 消された・非公開・予算切れ・
 * 1 記事あたりの上限超えのどれでも同じ。空の引用は表示側で「X のポストを開く」
 * リンクとして描く（web/src/style.css）ので、読み手には必ず何かが見える。
 * こちらで文言を焼き付けないことで、後から引き直せる状態も保たれる。
 */
export async function resolveTweetEmbeds(html: string, options: EmbedOptions): Promise<string> {
  if (!mayHaveTweetEmbed(html)) return html;

  const found = await findEmptyTweetQuotes(html);
  if (found.length === 0) return html;

  const resolved = await resolveAll(found.slice(0, MAX_PER_ENTRY), options);
  return resolved.size === 0 ? html : await replaceQuotes(html, resolved);
}

/** 空の引用（= 中身がリンクだけの blockquote）。index は文書中の blockquote の順番 */
interface EmptyQuote {
  index: number;
  url: string;
}

/**
 * 「中に文字が無く、X のポストへのリンクだけを持つ blockquote」を拾う。
 *
 * 文字があるものは触らない。フィードによっては引用の中にポスト本文がそのまま
 * 入っていることがあり（痛いニュースがそう）、それを引き直すと二重になる。
 */
async function findEmptyTweetQuotes(html: string): Promise<EmptyQuote[]> {
  const quotes: { index: number; url: string | null; text: number }[] = [];
  let depth = 0;
  let current: (typeof quotes)[number] | null = null;

  await new HTMLRewriter()
    .on('blockquote', {
      element(element) {
        const quote = { index: quotes.length, url: null as string | null, text: 0 };
        quotes.push(quote);
        // 入れ子の blockquote は外側だけを見る。内側は外側の一部として数える
        if (depth === 0) current = quote;
        depth += 1;
        element.onEndTag(() => {
          depth = Math.max(0, depth - 1);
          if (depth === 0) current = null;
        });
      },
    })
    .on('blockquote a', {
      element(element) {
        if (current === null || current.url !== null) return;
        const href = element.getAttribute('href');
        if (href !== null && TWEET_STATUS.test(href)) current.url = href;
      },
    })
    .on('*', {
      text(chunk) {
        if (current !== null) current.text += chunk.text.trim().length;
      },
    })
    .transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    .arrayBuffer();

  return quotes
    .filter(
      (quote): quote is EmptyQuote & { text: number } => quote.url !== null && quote.text === 0,
    )
    .map((quote) => ({ index: quote.index, url: quote.url }));
}

/** index → 差し替える HTML */
type Replacements = Map<number, string>;

async function resolveAll(targets: EmptyQuote[], options: EmbedOptions): Promise<Replacements> {
  const replacements: Replacements = new Map();
  // 取りに行く前に枠を確保する（クロールは並列に走る。fetch.ts の reserveBudget）
  const granted = reserveBudget(options.budget, targets.length);
  /**
   * まだ使っていない枠。**取りに行くと決めた時点で同期的に減らす。**
   * 「結果が入った件数」で見ると、同時に走る何本かが同じ値を読んでしまい、
   * 確保した数より多く投げることになる
   */
  let unused = granted;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (target) => {
        const canonical = unused > 0 ? canonicalTweetUrl(target.url) : null;
        if (canonical === null) return { target, html: null };
        unused -= 1;
        return { target, html: await fetchTweet(canonical, options.fetchImpl) };
      }),
    );
    for (const { target, html } of results) {
      // 引けたものだけ差し替える。引けなかったものは空の引用のまま残す
      if (html !== null) replacements.set(target.index, html);
    }
  }

  releaseBudget(options.budget, unused);
  return replacements;
}

/** oEmbed から引用を組み立てる。引けなければ null */
async function fetchTweet(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  // dnt=1 は X 側に「行動記録に使うな」と伝えるもの。omit_script=1 で
  // widgets.js の読み込みタグが応答に含まれなくなる（どのみち通さないが、無駄がない）
  const endpoint =
    `${OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}` +
    '&omit_script=1&dnt=1&hide_thread=1&lang=ja';

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('ポストの取得に失敗', url, describeNetworkError(err).message);
    return null;
  }
  // 消された・非公開のポストは 404。記事の側は直しようがないので黙って落とす
  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const quoted = (payload as { html?: unknown }).html;
  if (typeof quoted !== 'string' || quoted === '') return null;

  // 外から来た HTML なので必ずサニタイズを通す（不変条件 4）。
  // 相対 URL は無い想定だが、基準は X に置いておく
  const safe = await sanitizeHtml(quoted, 'https://x.com/');
  return safe === '' ? null : safe;
}

/** 拾ったときと同じ順番で blockquote を数え直し、対象を差し替える */
function replaceQuotes(html: string, replacements: Replacements): Promise<string> {
  let index = 0;
  return new HTMLRewriter()
    .on('blockquote', {
      element(element) {
        const replacement = replacements.get(index);
        index += 1;
        // 中身ごと差し替える。組み立てたのはサニタイズ済みの引用か自前のリンク
        if (replacement !== undefined) element.replace(replacement, { html: true });
      },
    })
    .transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    .text();
}
