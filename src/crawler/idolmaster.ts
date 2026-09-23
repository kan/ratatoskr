/**
 * アイドルマスター公式ニュース（https://idolmaster-official.jp/news）を取り込む。
 *
 * **RSS を出していない。** ニュースの一覧はページの JavaScript が裏の API から
 * 取ってくる作りで、素の HTML には入っていない。その API を引いて記事にする
 * （docs/DESIGN.md の「RSS を出さないサイトを取り込む」）。
 *
 * - 一覧の取得は 2 リクエスト。トークンを取り、そのトークンで一覧を引く。
 *   トークンは保存せず毎回取り直す（有効期限は 1 時間で、期限切れと取り直しの扱いを
 *   D1 に持ち込むほどの得が無い。NHK ONE と同じ判断）
 * - **一覧の並びは公開順ではない。** 編集者が入力する表示日の降順で、記事の id も
 *   単調に増えない。先頭だけを見て打ち切らず、毎回 50 件を同一性の判定に任せる
 * - 一覧に本文は入っていない。本文は全文取得（フィード単位でユーザが入れる）が
 *   記事ページの埋め込み JSON から採る
 */

import { asArray, asNumber, asObject, asString, parseJson } from '../lib/json';
import { apiChanged, notFetched, withFeed } from './api-feed';
import { fetchArticlePage, fetchFeed, type ArticlePageOutcome, type FetchTarget } from './fetch';
import { htmlResponse } from './rewriter';
import { escapeHtml, sanitizeHtml } from './sanitize';
import type { KnownSource, ParsedItem, SourceOutcome } from './types';

const SITE_HOST = 'idolmaster-official.jp';
const NEWS_URL = `https://${SITE_HOST}/news`;

const API_BASE = 'https://cmsapi-frontend.idolmaster-official.jp/sitern/api';
const TOKEN_URL = `${API_BASE}/cmsbase/Token/get`;
const LIST_URL = `${API_BASE}/idolmaster/Article/list`;
/** 画像の実体はここにある。記事中のパスはサイトの直下では 404 になる */
const IMAGE_URL = `${API_BASE}/idolmaster/Image/get`;

/**
 * 1 回に引く件数。
 *
 * 並びが公開順ではないので、後から公開された記事が一覧の途中に差し込まれる。
 * 表示日を公開の半日前にした記事が、その間に出た記事の下に並ぶ例を実際に見た。
 * 1 日に出る記事は 10 件前後なので、数日ぶんを毎回見れば取りこぼさない
 */
const LIST_SIZE = 50;

/** 記事のパス（`01_19877`）。URL に埋めるので、想定外の文字は通さない */
const ARTICLE_PATH = /^[0-9A-Za-z_-]+$/;
const ARTICLE_URL_PATH = /^\/news\/([0-9A-Za-z_-]+?)(?:\.html)?\/?$/;

/** 本文中の画像のパス。これで始まるものだけを画像の API へ付け替える */
const IMAGE_PATH_PREFIX = '/idolmaster/';

export const idolmasterNews: KnownSource = {
  url: NEWS_URL,
  title: 'アイドルマスター公式 ニュース',
  fetch: fetchNewsList,
};

async function fetchNewsList(target: FetchTarget, fetchImpl: typeof fetch): Promise<SourceOutcome> {
  // トークンも一覧も、取得の作法（名乗り、打ち切り、大きさの上限、失敗の分類）は
  // フィード本体と同じでよいので、fetchFeed に URL だけ差し替えて渡す
  const issued = await fetchFeed(
    { url: TOKEN_URL, etag: null, lastModified: null, contentHash: null },
    fetchImpl,
  );
  if (issued.kind !== 'fetched') return notFetched(issued, 'トークン');
  const token = asString(asObject(asObject(parseJson(issued.body))?.data)?.token);
  if (token === null) return apiChanged('トークンが発行されなかった');

  const params = new URLSearchParams({
    site: 'jp',
    ip: 'idolmaster',
    token,
    // ブランドは絞らない。どのブランドの記事かは本文に出す
    data: JSON.stringify({ category: ['NEWS'] }),
    limit: String(LIST_SIZE),
    start: '0',
  });
  // 一覧は ETag を返さない（no-store）。同じ内容なら本文が一字一句同じなので、
  // 前回の content_hash と比べて打ち切れる
  const listed = await fetchFeed(
    {
      url: `${LIST_URL}?${params}`,
      etag: null,
      lastModified: null,
      contentHash: target.contentHash,
    },
    fetchImpl,
  );
  if (listed.kind !== 'fetched') return notFetched(listed, 'ニュースの一覧');

  const data = asObject(asObject(parseJson(listed.body))?.data);
  if (data === null || !Array.isArray(data.article_list)) {
    return apiChanged('ニュースの一覧が読めない');
  }
  const items = data.article_list
    .map(toItem)
    .filter((item) => item !== null)
    // 同じ回に入る記事どうしは公開順に並べる。表示日の順のまま入れると、
    // 読む順が編集者の入力に左右される
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return withFeed(listed, { title: idolmasterNews.title, siteUrl: NEWS_URL, items });
}

function toItem(value: unknown): ParsedItem | null {
  const article = asObject(value);
  const id = asString(article?.['_id']);
  const path = asString(article?.path);
  if (article === null || id === null || path === null || !ARTICLE_PATH.test(path)) return null;

  return {
    guid: id,
    url: articleUrl(path),
    title: asString(article.title) ?? '',
    author: null,
    body: renderSummary(article),
    publishedAt: asNumber(article.startdate),
  };
}

function articleUrl(path: string): string {
  return `${NEWS_URL}/${path}`;
}

/**
 * 一覧から作る本文。サムネイルと、ブランドとカテゴリの名前だけ。
 *
 * サムネイルを `<img>` で入れるのは、画像の先読みの対象にするため
 */
function renderSummary(article: Record<string, unknown>): string {
  const thumbnail = asString(article.thumbnail);
  const image =
    thumbnail === null ? '' : `<p><img src="${escapeHtml(imageUrl(thumbnail))}" alt=""></p>`;

  const brands = names(article.brand);
  const categories = names(asObject(article.categories)?.subcategory);
  const labels = [brands.join('、'), categories.join('、')].filter((label) => label !== '');
  const caption = labels.length === 0 ? '' : `<p>${escapeHtml(labels.join(' ／ '))}</p>`;
  return image + caption;
}

function names(list: unknown): string[] {
  return asArray(list)
    .map((item) => asString(asObject(item)?.name))
    .filter((name) => name !== null);
}

/**
 * 記事中の画像のパスを、画像の API の URL にする。
 *
 * **サニタイズより前に呼ぶ。** サニタイズは相対 URL を記事 URL で絶対化するので、
 * その後ではサイト直下の、404 になる URL で確定してしまう。
 * サムネイルのパスに付く `?_=` は、付けたままだと API が 404 を返すので落とす
 */
function imageUrl(path: string): string {
  if (!path.startsWith(IMAGE_PATH_PREFIX)) return path;
  const bare = path.split('?', 1)[0];
  return `${IMAGE_URL}?path=${encodeURIComponent(bare)}`;
}

/**
 * 記事 URL が公式ニュースの記事を指しているか。指していれば記事のパスを返す。
 *
 * 全文取得の振り分けに使う。Bluesky や NHK ONE と同じく、記事ごとに決める
 */
export function idolmasterArticlePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== SITE_HOST) return null;
  return ARTICLE_URL_PATH.exec(parsed.pathname)?.[1] ?? null;
}

export interface IdolmasterArticles {
  /** 記事のパス → サニタイズ済みの本文 */
  bodies: Map<string, string>;
  /**
   * 取りに行って、確かに無かった記事のパス（消された記事、本文の空な記事、会員限定の記事）。
   *
   * **取りに行けなかったものは入れない。** 呼び出し側はこれを取り直しを止める印に使う
   * （src/crawler/fulltext.ts の FillOutcome）
   */
  missing: Set<string>;
  /**
   * 実際に取りに行った記事の数。枠は呼び出し側が記事の数だけ確保してあるので、
   * 途中で打ち切った分はこれを見て返す
   */
  attempted: number;
}

/**
 * 記事ページの埋め込み JSON から本文を採る。要求は記事ごとに 1 回。
 *
 * 記事ページは SSR で、`__NEXT_DATA__` に本文の HTML がまるごと入っている。
 * 本文の位置を採点して当てるより確か。
 *
 * **予算は受け取らない。** 記事 1 件に 1 リクエストで、全文取得が記事ページのために
 * 確保した枠の使い方と同じなので、呼び出し側の枠をそのまま使う
 */
export async function fetchIdolmasterArticles(
  paths: readonly string[],
  fetchImpl: typeof fetch,
): Promise<IdolmasterArticles> {
  const result: IdolmasterArticles = { bodies: new Map(), missing: new Set(), attempted: 0 };

  for (const path of paths) {
    result.attempted += 1;
    const outcome = await fetchArticle(path, fetchImpl);
    // **一時的な失敗が出たら残りは取りに行かない。** サイトが落ちている、ページの作りが
    // 変わった、はどちらも記事によらないので、残りも同じ結果になる
    if (outcome.kind === 'retry') break;
    if (outcome.kind === 'gone') {
      result.missing.add(path);
      continue;
    }
    // 自前で手を入れた HTML でも必ずサニタイズを通す（CLAUDE.md の不変条件 4）
    const html = await sanitizeHtml(await rewriteImages(outcome.html), articleUrl(path));
    if (html === '') result.missing.add(path);
    else result.bodies.set(path, html);
  }
  return result;
}

/**
 * 記事ページから本文の HTML を取り出す。`gone` は記事が無いか、取り込まない記事
 * （会員限定）。どちらも取り直しても結果は変わらない
 */
async function fetchArticle(path: string, fetchImpl: typeof fetch): Promise<ArticlePageOutcome> {
  const url = articleUrl(path);
  const page = await fetchArticlePage(url, fetchImpl);
  if (page.kind !== 'ok') return page;

  const data = asObject(asObject(asObject(await readNextData(page.html))?.props)?.pageProps)?.data;
  const article = asObject(data);
  // **埋め込み JSON が読めないのは、ページの作りが変わったとき。** 記事が無いのではない。
  // 印を付けると、作りが戻っても（こちらが直しても）その記事が二度と埋まらなくなる
  if (article === null) {
    console.warn('公式ニュースの記事に埋め込み JSON が無い（ページの作りが変わった？）', url);
    return { kind: 'retry' };
  }
  // 会員限定の記事の本文は取り込まない（docs/DESIGN.md）。題と URL だけで読む
  if (asString(article.memberflg) === '1') return { kind: 'gone' };

  const content = asString(article.content);
  return content === null || content === '' ? { kind: 'gone' } : { kind: 'ok', html: content };
}

/** `<script id="__NEXT_DATA__">` の中身を JSON として読む。読めなければ null */
async function readNextData(html: string): Promise<unknown> {
  let json = '';
  await new HTMLRewriter()
    .on('script#__NEXT_DATA__', {
      text(chunk) {
        json += chunk.text;
      },
    })
    .transform(htmlResponse(html))
    .arrayBuffer();
  return parseJson(json);
}

async function rewriteImages(html: string): Promise<string> {
  return new HTMLRewriter()
    .on('img[src]', {
      element(element) {
        const src = element.getAttribute('src');
        if (src !== null) element.setAttribute('src', imageUrl(src));
      },
    })
    .transform(htmlResponse(html))
    .text();
}
