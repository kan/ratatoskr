/**
 * 外から来た HTML / XML のバイト列を、宣言された文字コードで文字列に戻す。
 *
 * **`response.text()` は使わない。** あれは常に UTF-8 として読むので、Shift_JIS や
 * EUC-JP の文書（日本の古いサイトに多い）が化ける。外から来た HTML / XML を読む経路は
 * 全てここを通す（issue #35 / #36 / #37）。フィード本体・記事ページ・購読の検出は
 * src/crawler/fetch.ts の readBoundedMarkup、リンク先のタイトルは
 * src/crawler/page-title.ts、OPML の取り込みは src/api/opml.ts。
 *
 * 呼び出し側は HTML か XML かを指定しない。購読の検出のように、取りに行くまでどちらか
 * 分からない経路があるため。XML の宣言（`<?xml ?>`、文書の先頭にしか置けない）か
 * Content-Type で見分け、規則を分ける（chooseCharset）
 */

/** 文字コードの宣言を探す範囲。HTML の仕様が `<meta>` の事前走査に取る大きさと同じ */
const PRESCAN_BYTES = 1024;

/** 1 バイト 1 文字で読む。ASCII のタグを、元の文字コードに依らず探すのに使う */
export const LATIN1 = new TextDecoder('latin1');

/** 宣言の中の文字コード名 */
const LABEL = /([\w.:-]+)/u.source;
const CHARSET = new RegExp(`charset\\s*=\\s*["']?${LABEL}`, 'iu');
const XML_DECLARATION = /^\s*<\?xml\b[^>]*>/iu;
const XML_ENCODING = new RegExp(`\\bencoding\\s*=\\s*["']${LABEL}`, 'iu');

/** 知らない名前なら UTF-8 に倒す（TextDecoder は RangeError を投げる） */
export function decodeMarkup(bytes: Uint8Array, contentType: string | null): string {
  try {
    return new TextDecoder(chooseCharset(bytes, contentType)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * 文字コードを決める。どれにも当たらなければ UTF-8。
 *
 * - **BOM が最優先。** 実際のバイト列そのものの印なので、宣言より確か
 * - **JSON は UTF-8**（RFC 8259）。フィードの取得（fetchFeed）は JSON の API を返す
 *   取り込み口（src/crawler/idolmaster.ts 等）からも使われる。中身の HTML の文字列に
 *   `charset=` が入っていても、それで読み替えない
 * - **XML（フィード・OPML）は、文書の宣言を HTTP の charset より先に見る。** RFC 7303
 *   は HTTP を先にするが、既定の charset（`ISO-8859-1` 等）を一律に付けるサーバがあり、
 *   UTF-8 で書かれ宣言も合っているフィードが化ける。宣言は文書と一緒に書かれるので、
 *   こちらの方が外れにくい。**`<meta>` は見ない**（XML の中の `<meta>` は CDATA の中の
 *   記事の断片で、文書全体の宣言ではない）
 * - **HTML は仕様の順**: HTTP の charset → `<meta>`
 */
function chooseCharset(bytes: Uint8Array, contentType: string | null): string {
  const bom = bomCharset(bytes);
  if (bom !== null) return bom;
  if (contentType !== null && /json/iu.test(contentType)) return 'utf-8';

  const head = LATIN1.decode(bytes.subarray(0, PRESCAN_BYTES));
  const header = contentType === null ? null : (CHARSET.exec(contentType)?.[1] ?? null);
  const declaration = XML_DECLARATION.exec(head)?.[0] ?? null;

  if (declaration !== null || isXmlType(contentType)) {
    const declared = declaration === null ? null : (XML_ENCODING.exec(declaration)?.[1] ?? null);
    return asciiCompatible(declared ?? header) ?? 'utf-8';
  }
  return header ?? asciiCompatible(metaCharset(head)) ?? 'utf-8';
}

/** XML として読む種類か。XHTML（`application/xhtml+xml`）は HTML の側で `<meta>` も見る */
function isXmlType(contentType: string | null): boolean {
  return contentType !== null && /xml/iu.test(contentType) && !/html/iu.test(contentType);
}

/**
 * 頭を 1 バイト 1 文字で読んで見つけた宣言が UTF-16 なら、UTF-8 として扱う。
 *
 * 本当に UTF-16 なら、ASCII の部分が 0 を挟んだ形になり、宣言を見つけられない。
 * 見つかったということは、中身は ASCII 互換で、宣言の方が間違っている（HTML の仕様が
 * `<meta>` の結果に対して同じ扱いをする）
 */
function asciiCompatible(label: string | null): string | null {
  if (label === null) return null;
  return /^utf-16/iu.test(label) ? 'utf-8' : label;
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return null;
}

/**
 * `<meta charset="...">` と `<meta http-equiv="content-type" content="...; charset=...">`。
 * 宣言は ASCII で書かれるので、頭を 1 バイト 1 文字で読めば（`head`）、元の文字コードに
 * 依らず見つけられる
 */
function metaCharset(head: string): string | null {
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/giu)) {
    const found = CHARSET.exec(tag);
    if (found !== null) return found[1];
  }
  return null;
}
