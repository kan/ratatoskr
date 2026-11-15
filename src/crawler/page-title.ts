import { ARTICLE_ACCEPT, describeNetworkError, USER_AGENT } from './fetch';
import { elementScope, htmlResponse } from './rewriter';
import { normalizeText } from './title';

/**
 * リンク先のページのタイトル（issue #34）。記事内のリンクのピン（docs/UX.md
 * 「記事内のリンク」）の見出しが URL のままだと、後から一覧を見ても何のページか
 * 分からないので、ピンを受けたサーバがリンク先を引いて補う（src/api/pins.ts）。
 *
 * **引けなければ null に倒す。** 呼び出し側は送られた見出し（URL）をそのまま控える。
 * ピンの追加そのものは失敗させない。
 */

/**
 * 打ち切り。**クロールの TIMEOUT_MS（15 秒）より短くする。**
 *
 * ピンの送信は outbox が既読の送信とまとめて待つ（web/src/stores/outbox.ts の flush）。
 * ここで長く待つと、その間は既読も他の端末へ届かない。見出しは補えなくても URL が残る
 */
export const PAGE_TITLE_TIMEOUT_MS = 5_000;

/**
 * 読む大きさの上限。タイトルは `<head>` にあるので、ページ全体は要らない。
 * `<head>` に大きなスクリプトを埋め込むページもあるので、余裕を持たせてある
 */
const READ_LIMIT = 512 * 1024;

/** 文字コードの宣言を探す範囲。HTML の仕様が `<meta>` の事前走査に取る大きさと同じ */
const PRESCAN_BYTES = 1024;

/** 1 バイト 1 文字で読む。ASCII のタグを、元の文字コードに依らず探すのに使う */
const LATIN1 = new TextDecoder('latin1');

/** 読むのをやめる目印。境目の持ち越しの長さもこれで決まる */
const HEAD_END = '</head';

/**
 * 見出しが URL の形か。**このときだけリンク先を引く。**
 *
 * リンクの文字が「詳しくはこちら」のような言葉なら、書いた人が付けた名前なので残す。
 * URL の形のものは 2 通りある。
 *
 * - `https://` から始まる URL そのもの（文字の無いリンクで、画面が URL を入れて送る）
 * - **省略された URL。** Bluesky はリンクの文字を `example.com/path/to...` のように
 *   スキームを落として切り詰める（facet の文字がそれ）。省略記号を除いて、ピンの
 *   URL の頭と一致するかで見る。パスの日本語は、文字では生のまま、URL では
 *   パーセントエンコードされて来るので、両方の形と比べる
 *
 * 空は対象外。記事のピンで見出しが空なら、記事の本文の書き出しで補う（従来どおり）
 */
export function looksLikeUrl(title: string, url: string): boolean {
  const text = title.trim();
  if (text === '') return false;
  if (/^https?:\/\/\S+$/iu.test(text)) return true;

  // スキーム付きの文字は上で決着しているので、ここに来るのはスキームの無い形だけ
  const head = text.replace(/(\.\.\.|…)$/u, '').toLowerCase();
  // **ドメインの区切り（`.` か `/`）を含むものだけ。** 含まないと、`note` → `https://note.com/…`
  // のように、ホスト名の頭と重なる普通の言葉まで URL と見なして置き換える
  if (head === '' || /\s/u.test(head) || !/[./]/u.test(head)) return false;

  const target = url.replace(/^https?:\/\//iu, '').toLowerCase();
  return target.startsWith(head) || safeDecodeUri(target).startsWith(head);
}

function safeDecodeUri(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/**
 * リンク先のページを引いてタイトルを取る。`og:title` があればそちら、無ければ `<title>`。
 *
 * `og:title` を先にするのは、`<title>` にはサイト名が付くことが多い
 * （「記事名 | サイト名」）ため。ピンの一覧で見たいのは記事名の方。
 */
export async function fetchPageTitle(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  // 組み立て（HTMLRewriter）まで try に入れる。どこで落ちてもピンの追加は 500 にしない。
  // 500 にすると outbox が送り直し、同じページで落ち続けてピンがサーバに残らない
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: ARTICLE_ACCEPT },
      // 短縮 URL やリダイレクトを挟む紹介先が多い。行き着いた先のタイトルを取る
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TITLE_TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type');
    // PDF や画像を指すリンクもある。タイトルの採りようが無いので読まずに捨てる
    if (!response.ok || (contentType !== null && !/html/iu.test(contentType))) {
      await response.body?.cancel();
      return null;
    }
    return await titleFromHtml(decodeHtml(await readHead(response), contentType));
  } catch (err) {
    const { message } = describeNetworkError(err, PAGE_TITLE_TIMEOUT_MS);
    console.warn('リンク先のタイトルの取得に失敗', url, message);
    return null;
  }
}

/**
 * `</head>` が見えるか READ_LIMIT に届くまで読み、残りは読まずに切る。
 * 上限は目安なので、最後の 1 塊ぶん越えるのは構わない
 */
async function readHead(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  // 前の塊の末尾。`</head` が塊の境目で割れても見つけられるように、つないで照合する
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    const seen = carry + LATIN1.decode(value);
    carry = seen.slice(-HEAD_END.length);
    if (total >= READ_LIMIT || /<\/head/iu.test(seen)) {
      await reader.cancel();
      break;
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * バイト列を文字列に戻す。**`response.text()` は使わない。** あれは常に UTF-8 として
 * 読むので、Shift_JIS や EUC-JP のページのタイトルが化ける（日本の古いサイトに多い）。
 *
 * 文字コードは HTML の仕様の順で決める: BOM → Content-Type の charset →
 * 頭の `<meta>` の宣言 → UTF-8。知らない名前なら UTF-8 に倒す
 */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const label = bomCharset(bytes) ?? headerCharset(contentType) ?? metaCharset(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // 知らない名前の TextDecoder は RangeError を投げる
    return new TextDecoder().decode(bytes);
  }
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return null;
}

const CHARSET = /charset\s*=\s*["']?([\w.:-]+)/iu;

function headerCharset(contentType: string | null): string | null {
  return contentType === null ? null : (CHARSET.exec(contentType)?.[1] ?? null);
}

/**
 * `<meta charset="...">` と `<meta http-equiv="content-type" content="...; charset=...">`。
 * 宣言は ASCII で書かれるので、頭を 1 バイト 1 文字で読めば、元の文字コードに
 * 依らず見つけられる
 */
function metaCharset(bytes: Uint8Array): string | null {
  const head = LATIN1.decode(bytes.subarray(0, PRESCAN_BYTES));
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/giu)) {
    const found = CHARSET.exec(tag);
    if (found !== null) return found[1];
  }
  return null;
}

/**
 * HTML からタイトルを取る。どちらも無ければ null。
 *
 * **最初の `<title>` だけを見る。** `<body>` の中の SVG のアイコンも `<title>` を持つので、
 * 後のものまで拾うとアイコンの名前が混ざる
 */
export async function titleFromHtml(html: string): Promise<string | null> {
  // ハンドラの中で書き換えるので、let ではなく入れ物に持つ（let だと、ハンドラでの
  // 代入が型の絞り込みに伝わらない）
  const found: { og: string | null; title: string; state: 'before' | 'inside' | 'done' } = {
    og: null,
    title: '',
    state: 'before',
  };

  await new HTMLRewriter()
    .on('meta[property="og:title"], meta[name="og:title"]', {
      element(element) {
        found.og ??= element.getAttribute('content');
      },
    })
    .on('title', {
      element(element) {
        if (found.state !== 'before') return;
        // 終了タグの無い <title>（SVG の自己終了タグ）には入らない（src/crawler/rewriter.ts）
        elementScope(
          element,
          () => {
            found.state = 'inside';
          },
          () => {
            found.state = 'done';
          },
        );
      },
      text(chunk) {
        if (found.state === 'inside') found.title += chunk.text;
      },
    })
    .transform(htmlResponse(html))
    .arrayBuffer();

  // HTMLRewriter のテキストと属性値は生のソースなので、実体参照は解かれていない
  return clean(found.og) ?? clean(found.title);
}

function clean(text: string | null): string | null {
  const squashed = text === null ? '' : normalizeText(text);
  return squashed === '' ? null : squashed;
}
