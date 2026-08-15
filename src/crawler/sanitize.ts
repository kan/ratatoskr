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

// 中身ごと捨てるタグ。これ以外の未知タグはタグだけ剥がして中身を残す
const DROPPED_TAGS = tagSet(`
  applet audio base button canvas embed form frame frameset head iframe input link
  math meta noscript object script select style svg template textarea title video
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
        const tag = element.tagName.toLowerCase();

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
      },
    })
    .transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

  return await response.text();
}
