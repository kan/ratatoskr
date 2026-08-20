/**
 * ホワイトリスト方式のサニタイザ。
 *
 * entries.body には**サニタイズ済み HTML のみ**を入れる（CLAUDE.md の不変条件 4）。
 * クライアントは v-html で描くので、DB の中身が信頼できることが安全性の全て。
 *
 * HTMLRewriter はネイティブ実装のストリーミングパーサで、この用途に向いている。
 * RSS/Atom 自体のパースには使わない（HTML 専用）。
 */

// 記事本文として意味のあるタグだけを残す
const ALLOWED_TAGS = tagSet(`
  a abbr b blockquote br caption cite code dd del div dl dt em figcaption figure
  h1 h2 h3 h4 h5 h6 hr i img ins kbd li ol p pre q s samp small span strong sub sup
  table tbody td tfoot th thead time tr u ul var
`);

// 中身ごと捨てるタグ。これ以外の未知タグはタグだけ剥がして中身を残す。
//
// RAWTEXT / PLAINTEXT として扱われるタグ（script style textarea title iframe
// noscript noembed noframes xmp plaintext）は必ずこちらに入れること。中身が
// 要素としてパースされないため、removeAndKeepContent で剥がすと生のマークアップが
// そのまま出てしまい、ブラウザ側で改めて解釈されてサニタイズが素通りする
const DROPPED_TAGS = tagSet(`
  applet audio base button canvas embed form frame frameset head iframe input link
  math meta noembed noframes noscript object plaintext script select style svg
  template textarea title video xmp
`);

function tagSet(tags: string): Set<string> {
  return new Set(tags.trim().split(/\s+/));
}

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  blockquote: ['cite'],
  q: ['cite'],
  time: ['datetime'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start'],
};

const URL_ATTRS = new Set(['href', 'src', 'cite']);
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * 属性値の URL を絶対 URL に直し、安全なスキームのものだけを通す。
 * javascript: や data: はここで落ちる。相対 URL は base が無ければ捨てる
 * （自分のオリジンに解決されてしまい、リンクとして無意味なため）。
 */
function safeUrl(value: string, baseUrl: string | null): string | null {
  let url: URL;
  try {
    url = baseUrl === null ? new URL(value) : new URL(value, baseUrl);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

/**
 * 埋め込みの iframe を、行き先の分かるリンクに差し替える。
 *
 * iframe は通さない（中で何が動くか分からない）が、落とすだけだと動画やスライドが
 * **跡形もなく消えて記事の意味が通らなくなる。** 提供元が分かるものに限って、
 * 「開く」リンクに置き換える。ホストを絞るのは、計測用の隠し iframe まで
 * リンクにしてしまわないため。
 */
const EMBED_HOSTS: readonly { readonly suffix: string; readonly label: string }[] = [
  { suffix: 'youtube.com', label: 'YouTube の動画を開く' },
  { suffix: 'youtube-nocookie.com', label: 'YouTube の動画を開く' },
  { suffix: 'youtu.be', label: 'YouTube の動画を開く' },
  { suffix: 'nicovideo.jp', label: 'ニコニコ動画を開く' },
  { suffix: 'vimeo.com', label: 'Vimeo の動画を開く' },
  { suffix: 'open.spotify.com', label: 'Spotify で開く' },
  { suffix: 'soundcloud.com', label: 'SoundCloud で開く' },
  { suffix: 'bandcamp.com', label: 'Bandcamp で開く' },
  { suffix: 'speakerdeck.com', label: 'Speaker Deck を開く' },
  { suffix: 'docswell.com', label: 'Docswell を開く' },
  { suffix: 'x.com', label: 'X のポストを開く' },
  { suffix: 'twitter.com', label: 'X のポストを開く' },
];

function embedHostLabel(host: string): string | null {
  const lower = host.toLowerCase();
  for (const entry of EMBED_HOSTS) {
    if (lower === entry.suffix || lower.endsWith(`.${entry.suffix}`)) return entry.label;
  }
  return null;
}

/** 属性値に埋め込める形にする。ここで作る HTML は自分で組み立てるので必ず通す */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** 埋め込み URL から、人が開いて意味のある URL に直す */
function watchableUrl(url: URL): string {
  // youtube.com/embed/ID は開けなくはないが、視聴ページの方が素直
  const video = /^\/embed\/([A-Za-z0-9_-]{6,})$/.exec(url.pathname);
  if (video !== null && embedHostLabel(url.hostname) === 'YouTube の動画を開く') {
    return `https://www.youtube.com/watch?v=${video[1]}`;
  }
  return url.href;
}

function embedLink(src: string | null, baseUrl: string | null): string | null {
  if (src === null) return null;
  const resolved = safeUrl(src, baseUrl);
  if (resolved === null) return null;

  const url = new URL(resolved);
  const label = embedHostLabel(url.hostname);
  if (label === null) return null;

  // p で包まない。WordPress の埋め込みは <p><iframe></iframe></p> の形なので、
  // 包むと p の入れ子になり、ブラウザの解釈で段落が分断される
  const href = escapeAttribute(watchableUrl(url));
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** ホワイトリストを 1 要素に当てる。sanitizeHtml と sanitizeWithin で共有する */
function applyPolicy(element: Element, baseUrl: string | null): void {
  const tag = element.tagName.toLowerCase();

  if (tag === 'iframe') {
    // 中身ごと消えるのは remove と同じ。通すのはこちらが組み立てたリンクだけ
    const link = embedLink(element.getAttribute('src'), baseUrl);
    if (link === null) element.remove();
    else element.replace(link, { html: true });
    return;
  }

  if (DROPPED_TAGS.has(tag)) {
    element.remove();
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    // 未知のタグは中身だけ残す。span/font のような装飾は消えて本文は残る
    element.removeAndKeepContent();
    return;
  }

  const allowed = ALLOWED_ATTRS[tag] ?? [];
  // 走査中に消すと反復子が壊れるので、先に一覧を取る
  for (const [name, value] of [...element.attributes]) {
    const lower = name.toLowerCase();
    if (!allowed.includes(lower)) {
      element.removeAttribute(name);
      continue;
    }
    if (!URL_ATTRS.has(lower)) continue;

    const resolved = safeUrl(value, baseUrl);
    if (resolved === null) element.removeAttribute(name);
    else element.setAttribute(name, resolved);
  }

  // width/height を落として max-width: 100% を効かせる（docs/DESIGN.md §5）
  if (tag === 'img') {
    element.removeAttribute('width');
    element.removeAttribute('height');
  }
  // 記事内リンクは別タブで開く。opener 経由で元ページを触らせない
  if (tag === 'a') {
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  }
}

// 記事ページ 1 枚まるごとを渡されることがある（crawler/extract.ts）。body に入るのは
// 断片なので doctype は要らない。HTMLRewriter の Doctype には remove() が無く
// ハンドラからは落とせないので、渡す前に削っておく
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

export function htmlResponse(html: string): Response {
  return new Response(html.replace(LEADING_DOCTYPE, ''), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function sanitizeHtml(html: string, baseUrl: string | null = null): Promise<string> {
  if (html.trim() === '') return '';

  const response = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        // 条件付きコメントなどに紛れる余地を残さない
        comment.remove();
      },
    })
    .on('*', {
      element(element) {
        applyPolicy(element, baseUrl);
      },
    })
    .transform(htmlResponse(html));

  return await response.text();
}

/**
 * セレクタで指した要素の**中身だけ**をサニタイズして返す。見つからなければ null。
 *
 * 記事ページから本文を取り出すのに使う（crawler/extract.ts）。切り出してから
 * サニタイズするのではなく 1 回の走査で済ませているのは、HTMLRewriter が要素の
 * 位置を教えてくれないため。位置を得るために自前で HTML を走査すると、閉じ忘れや
 * 属性値の中の `>` で簡単に壊れる。
 *
 * 外側は「タグを剥がして中身を残す」ではなく「テキストごと捨てる」。本文の前後には
 * ナビゲーションや関連記事が必ずあり、剥がすだけではそれが本文に混ざる。
 */
export async function sanitizeWithin(
  html: string,
  selector: string,
  baseUrl: string | null = null,
): Promise<string | null> {
  let matched = false;
  /** 対象の中にいるか。開始タグで立て、終了タグで倒す */
  let inside = false;

  const response = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .on(selector, {
      element(element) {
        // 同じセレクタに複数当たることは無い前提だが（extract.ts が一意なものしか
        // 選ばない）、当たったら最初の 1 つだけを見る
        if (matched) return;
        matched = true;
        inside = true;
        element.onEndTag(() => {
          inside = false;
        });
      },
    })
    .on('*', {
      element(element) {
        if (!inside) {
          // 対象の祖先はまだ「外側」として通る。remove() で消すと対象ごと消えるので、
          // タグだけ剥がして中身は流す。外側のテキストは下の text で落ちるので、
          // 剥がした結果が本文に混ざることはない
          const tag = element.tagName.toLowerCase();
          if (DROPPED_TAGS.has(tag)) element.remove();
          else element.removeAndKeepContent();
          return;
        }
        applyPolicy(element, baseUrl);
      },
      text(chunk) {
        if (!inside) chunk.remove();
      },
    })
    .transform(htmlResponse(html));

  const body = await response.text();
  return matched ? body.trim() : null;
}
