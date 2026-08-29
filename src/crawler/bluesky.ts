/**
 * Bluesky の投稿を、記事ページではなく AT Protocol の API から取ってくる。
 *
 * **bsky.app の投稿ページは SPA で、本文が HTML に入っていない。** 返るのは 10KB の
 * 殻と `og:description`（RSS と同じテキスト）だけなので、走査しても候補は 1 つも
 * 出ない。そのままだと新着 1 件ごとに 1 リクエストを捨て、cron 1 回ぶんの全文取得の
 * 枠（20 件）を食って他のフィードを圧迫する。
 *
 * RSS には投稿のテキストが最初から入っているので、**API から採るのはテキストでは
 * なく「RSS に無いもの」**——画像・外部リンクのカード・引用投稿・リンクの facet。
 * 画像が `<img>` で本文に入って初めて、画像の先読み（docs/DESIGN.md）が効く。
 * 改行も RSS の平文では潰れてしまうので、ここで `<br>` に直す。
 *
 * 認証は要らない（public.api.bsky.app）。**10 件を 1 リクエストで取れる**ので、
 * 記事ページを 1 枚ずつ引くより相手のサーバにも優しい。
 */

import { fetchJson, releaseBudget, reserveBudget, type FetchBudget } from './fetch';
import { escapeHtml, sanitizeHtml } from './sanitize';

const APPVIEW = 'https://public.api.bsky.app/xrpc';

/** getPosts が 1 回で受け取れる at-uri の数（lexicon の上限） */
const MAX_URIS = 25;

/** 相対 URL の基準。API が返すのは絶対 URL だが、サニタイズには基準が要る */
const BASE_URL = 'https://bsky.app/';

const POST_PATH = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9.-]+)\/?$/;

export interface BlueskyPostRef {
  /** ハンドル（`kan.fushihara.net`）か DID（`did:plc:…`） */
  actor: string;
  /** 投稿の rkey */
  rkey: string;
}

/**
 * 記事 URL が Bluesky の投稿を指しているか。指していれば投稿者と rkey を返す。
 *
 * **フィードの URL では判断しない。** bsky.app の RSS は
 * `/profile/<handle>/rss` でも `/profile/<did>/rss` でも配られるうえ、
 * 記事 URL の側は常にハンドルで来る（実測）。判断も組み立ても記事 URL に寄せる
 */
export function blueskyPostRef(url: string): BlueskyPostRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'bsky.app') return null;

  const match = POST_PATH.exec(parsed.pathname);
  if (match === null) return null;

  // `%` が 1 つ入っているだけの URL でも `new URL` は通る（実測）。ここで投げると
  // 記事 URL 1 本で fillFullText ごと落ちて、そのフィードの全文が毎クロール
  // 埋まらなくなる（例外は crawl の Promise.allSettled に拾われて表に出ない）
  try {
    return { actor: decodeURIComponent(match[1]), rkey: match[2] };
  } catch {
    return null;
  }
}

export interface BlueskyOptions {
  fetchImpl: typeof fetch;
  budget: FetchBudget;
}

export interface BlueskyPosts {
  /** rkey → 組み立てた HTML */
  bodies: Map<string, string>;
  /**
   * 取りに行って、確かに無かった投稿の rkey（消された・非公開）。
   *
   * **取りに行けなかったものはここに入らない。** API が落ちている・名前が引けない・
   * 予算が届かなかった、はどれも時間を置けば直る。呼び出し側はこれを「取り直しを
   * 止める印」に使うので（src/crawler/fulltext.ts の FillOutcome）、混ぜると
   * 一時的な失敗が永久の諦めになる
   */
  missing: Set<string>;
}

/**
 * 投稿を組み立てて返す。
 *
 * 使う要求は**投稿者ごとに 1〜2 回だけ**（ハンドルを DID に直すのに 1 回、
 * 投稿を 25 件ずつまとめて取るのに 1 回）。ハンドルを直すのが要るのは getPosts が
 * DID しか受け付けないため——ハンドル形式の at-uri を渡すと、エラーではなく
 * **空の配列**が返る（実測）ので、握り潰すと「投稿が全部消えた」と区別が付かない。
 */
export async function fetchBlueskyPosts(
  refs: readonly BlueskyPostRef[],
  options: BlueskyOptions,
): Promise<BlueskyPosts> {
  const byActor = new Map<string, string[]>();
  for (const ref of refs) {
    const group = byActor.get(ref.actor);
    if (group === undefined) byActor.set(ref.actor, [ref.rkey]);
    else group.push(ref.rkey);
  }

  const result: BlueskyPosts = { bodies: new Map(), missing: new Set() };
  if (byActor.size === 0) return result;

  // **要る数をそのまま確保する。** 多めに取ると、返すのは全ての取得を待った後に
  // なるので、その間だけ他のフィードから見た残りが実際より少なくなる
  // （クロールはフィードを並列に回す。fetch.ts の reserveBudget）
  let unused = reserveBudget(options.budget, requestCount(byActor));

  for (const [actor, rkeys] of byActor) {
    if (unused < 1) break;

    let did = actor;
    if (!actor.startsWith('did:')) {
      unused -= 1;
      const resolved = await resolveHandle(actor, options.fetchImpl);
      // 名前が引けないのは一時的なこともある。印は残さず次の機会に回す
      if (resolved === null) continue;
      did = resolved;
    }

    for (let i = 0; i < rkeys.length && unused > 0; i += MAX_URIS) {
      unused -= 1;
      const chunk = rkeys.slice(i, i + MAX_URIS);
      const fetched = await fetchPosts(did, chunk, options.fetchImpl);
      // 要求そのものが通らなかった。何が無いのかは分からないので何も決めない
      if (fetched === null) continue;

      for (const rkey of chunk) {
        const html = fetched.get(rkey);
        // 応答は返ったのに入っていない = 消された・非公開の投稿
        if (html === undefined) result.missing.add(rkey);
        else result.bodies.set(rkey, html);
      }
    }
  }

  releaseBudget(options.budget, unused);
  return result;
}

/** 投稿者ごとに「ハンドルを直す分 + まとめて取る回数」 */
function requestCount(byActor: Map<string, string[]>): number {
  let count = 0;
  for (const [actor, rkeys] of byActor) {
    if (!actor.startsWith('did:')) count += 1;
    count += Math.ceil(rkeys.length / MAX_URIS);
  }
  return count;
}

async function resolveHandle(handle: string, fetchImpl: typeof fetch): Promise<string | null> {
  const payload = await fetchJson(
    `${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    fetchImpl,
    'Bluesky の名前',
  );
  const did = asString(asObject(payload)?.did);
  return did !== null && did.startsWith('did:') ? did : null;
}

/**
 * rkey → 組み立てた HTML。消された投稿は入らない。
 * **要求そのものが通らなかったときは null**（「無い」と区別が付かないため）。
 */
async function fetchPosts(
  did: string,
  rkeys: string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, string> | null> {
  const query = rkeys
    .map((rkey) => `uris=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${rkey}`)}`)
    .join('&');
  const payload = await fetchJson(
    `${APPVIEW}/app.bsky.feed.getPosts?${query}`,
    fetchImpl,
    'Bluesky の投稿',
  );

  const posts = asObject(payload)?.posts;
  if (!Array.isArray(posts)) return null;

  const built = new Map<string, string>();

  for (const post of posts) {
    const uri = asString(asObject(post)?.uri);
    if (uri === null) continue;
    const rkey = uri.slice(uri.lastIndexOf('/') + 1);

    // 自前で組み立てた HTML でも必ずサニタイズを通す（CLAUDE.md の不変条件 4）。
    // 中身は API から来た文字列なので、通す先を 1 か所に保つ方が確かめやすい
    const html = await sanitizeHtml(renderPost(post), BASE_URL);
    if (html !== '') built.set(rkey, html);
  }
  return built;
}

/**
 * 投稿 1 件を HTML に落とす。
 *
 * **RSS が既に持っているテキストも書き直す。** RSS の description は平文なので、
 * 改行が HTML では潰れる（体重ログのような行の並ぶ投稿が 1 行に繋がる）し、
 * リンクもただの文字列になる。テキストごと組み立て直した方が結果が揃う。
 */
function renderPost(post: unknown): string {
  const text = renderText(asObject(asObject(post)?.record));
  const attached = renderEmbed(asObject(asObject(post)?.embed));

  // **テキストが空なら段落ごと落とす。** 読み出しは COALESCE(NULLIF(full_body, ''), body)
  // なので、`<p></p>` だけの全文は「空でない」として RSS の本文を押しのけ、記事が
  // 真っ白になる。埋め込みも無ければ全体が空文字になり、呼び出し側が
  // 「取りに行ったが採らなかった」印を付ける（消された投稿を引用しただけの投稿など）
  return (text === '' ? '' : `<p>${text}</p>`) + attached;
}

/** 投稿のテキスト。facet の付いたところはリンクになる */
function renderText(record: Record<string, unknown> | null): string {
  return richText(asString(record?.text) ?? '', asArray(record?.facets));
}

function renderEmbed(embed: Record<string, unknown> | null): string {
  switch (asString(embed?.$type)) {
    case 'app.bsky.embed.images#view':
      return renderImages(asArray(embed?.images));
    case 'app.bsky.embed.video#view':
      return renderImage(asString(embed?.thumbnail), asString(embed?.alt));
    case 'app.bsky.embed.external#view':
      return renderExternal(asObject(embed?.external));
    case 'app.bsky.embed.record#view':
      return renderQuote(asObject(embed?.record));
    // 画像やリンクカードと引用が同時に付いた投稿。どちらも単体のときと同じ形で来る
    case 'app.bsky.embed.recordWithMedia#view':
      return renderEmbed(asObject(embed?.media)) + renderEmbed(asObject(embed?.record));
    default:
      return '';
  }
}

function renderImages(images: unknown[]): string {
  return images
    .map((image) =>
      renderImage(asString(asObject(image)?.fullsize), asString(asObject(image)?.alt)),
    )
    .join('');
}

/** alt は figcaption にも出す。Bluesky の alt は説明文として書かれていることが多い */
function renderImage(src: string | null, alt: string | null): string {
  if (src === null) return '';
  const caption = alt === null || alt === '' ? '' : `<figcaption>${escapeText(alt)}</figcaption>`;
  return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? '')}">${caption}</figure>`;
}

/**
 * 外部リンクのカード。**このフィードで一番多い埋め込み**（実測 400 件中 68 件）で、
 * RSS 側には URL の文字列しか残らない。
 */
function renderExternal(external: Record<string, unknown> | null): string {
  if (external === null) return '';
  const uri = asString(external.uri);
  if (uri === null) return '';

  const href = escapeHtml(uri);
  const title = escapeText(asString(external.title) ?? uri);
  const description = asString(external.description) ?? '';
  const caption =
    `<figcaption><a href="${href}">${title}</a>` +
    (description === '' ? '' : `<br>${escapeText(description)}`) +
    '</figcaption>';

  const thumb = asString(external.thumb);
  // 画像が無いカードを figure にすると、絵の無い figcaption だけが残る
  if (thumb === null) return `<p><a href="${href}">${title}</a></p>`;
  return `<figure><a href="${href}"><img src="${escapeHtml(thumb)}" alt=""></a>${caption}</figure>`;
}

/**
 * 引用された投稿。**入れ子の引用までは辿らない。**
 * 引用の引用は元の投稿を読むうえで要らないうえ、深さの上限が要る話になる。
 */
function renderQuote(record: Record<string, unknown> | null): string {
  // 消された・非公開・引用を外された投稿は viewRecord ではない形で来る
  if (record === null || asString(record.$type) !== 'app.bsky.embed.record#viewRecord') return '';

  const author = asObject(record.author);
  const handle = asString(author?.handle);
  const uri = asString(record.uri);

  const parts: string[] = [];
  if (handle !== null && uri !== null) {
    const name = asString(author?.displayName) ?? handle;
    const rkey = uri.slice(uri.lastIndexOf('/') + 1);
    const href = escapeHtml(`https://bsky.app/profile/${handle}/post/${rkey}`);
    parts.push(`<p><a href="${href}">${escapeText(name)} (@${escapeText(handle)})</a></p>`);
  }
  parts.push(`<p>${renderText(asObject(record.value))}</p>`);
  // 引用元に付いていた画像・リンクカードまでは出す（引用の引用は出さない）
  for (const embed of asArray(record.embeds)) {
    const nested = asObject(embed);
    const type = asString(nested?.$type);
    if (type === 'app.bsky.embed.record#view' || type === 'app.bsky.embed.recordWithMedia#view') {
      continue;
    }
    parts.push(renderEmbed(nested));
  }
  return `<blockquote>${parts.join('')}</blockquote>`;
}

/**
 * facet を当ててリンクにする。
 *
 * **facet の位置は UTF-8 のバイト数で来る。** JavaScript の文字列は UTF-16 なので、
 * そのまま `slice` すると日本語の投稿で必ずずれる（記事本文が壊れて保存される）。
 * バイト列に直してから切り、切った断片を戻す。
 *
 * 範囲が重なっているもの・文字の途中を指すものは捨てる。API が壊れた facet を
 * 返すことは無い想定だが、外から来た数値をそのまま位置に使うので確かめておく。
 */
function richText(text: string, facets: unknown[]): string {
  // facet の無い投稿が多数派。バイト列に直して戻すだけの往復を省く
  if (facets.length === 0) return escapeText(text);

  const bytes = ENCODER.encode(text);
  const links = facets
    .map((facet) => toLink(facet, bytes))
    .filter((link): link is FacetLink => link !== null)
    .sort((a, b) => a.start - b.start);
  if (links.length === 0) return escapeText(text);

  let cursor = 0;
  let html = '';
  for (const link of links) {
    if (link.start < cursor) continue;
    // subarray はコピーを作らない。decode はビューをそのまま受け取れる
    html += escapeText(DECODER.decode(bytes.subarray(cursor, link.start)));
    const label = escapeText(DECODER.decode(bytes.subarray(link.start, link.end)));
    html += `<a href="${escapeHtml(link.href)}">${label}</a>`;
    cursor = link.end;
  }
  return html + escapeText(DECODER.decode(bytes.subarray(cursor)));
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface FacetLink {
  start: number;
  end: number;
  href: string;
}

function toLink(facet: unknown, bytes: Uint8Array): FacetLink | null {
  const index = asObject(asObject(facet)?.index);
  const start = asNumber(index?.byteStart);
  const end = asNumber(index?.byteEnd);
  if (start === null || end === null || start < 0 || end <= start || end > bytes.length)
    return null;
  // 文字の途中で切ると、切った断片が U+FFFD になって本文に残る
  if (isContinuation(bytes[start]) || isContinuation(bytes[end])) return null;

  for (const feature of asArray(asObject(facet)?.features)) {
    const shape = asObject(feature);
    const type = asString(shape?.$type);
    // タグは素のままにする。行き先が検索画面になるだけで、読むのに要らない
    if (type === 'app.bsky.richtext.facet#link') {
      const uri = asString(shape?.uri);
      if (uri !== null) return { start, end, href: uri };
    }
    if (type === 'app.bsky.richtext.facet#mention') {
      const did = asString(shape?.did);
      if (did !== null) return { start, end, href: `https://bsky.app/profile/${did}` };
    }
  }
  return null;
}

/**
 * UTF-8 の 2 バイト目以降か。文字の途中を指す facet を見分けるのに使う
 * （末尾がちょうど文字列の終わりのときは undefined が来るので、それは境界）。
 */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * エスケープに加えて改行を `<br>` にする。**RSS の平文では潰れていた部分。**
 * 改行の扱いは描画の決めごとなので、エスケープ（sanitize.ts の escapeHtml）とは別にする
 */
function escapeText(text: string): string {
  return escapeHtml(text).replaceAll('\n', '<br>');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
