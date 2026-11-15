/**
 * HTML のバイト列を、宣言された文字コードで文字列に戻す。
 *
 * **`response.text()` は使わない。** あれは常に UTF-8 として読むので、Shift_JIS や
 * EUC-JP のページ（日本の古いサイトに多い）が化ける。HTML のページを読む経路
 * （全文取得の src/crawler/fetch.ts の readBoundedHtml と、リンク先のタイトルの
 * src/crawler/page-title.ts）は、ここを通す。
 *
 * フィード本体（XML）は対象外。XML は `<?xml encoding?>` で宣言するので、規則が違う
 */

/** 文字コードの宣言を探す範囲。HTML の仕様が `<meta>` の事前走査に取る大きさと同じ */
const PRESCAN_BYTES = 1024;

/** 1 バイト 1 文字で読む。ASCII のタグを、元の文字コードに依らず探すのに使う */
export const LATIN1 = new TextDecoder('latin1');

/**
 * 文字コードは HTML の仕様の順で決める: BOM → Content-Type の charset →
 * 頭の宣言（XML の宣言か `<meta>`）→ UTF-8。知らない名前なら UTF-8 に倒す
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
  // XHTML は XML の宣言だけで文字コードを示すことがある（Accept で XHTML も受けている。
  // src/crawler/fetch.ts の ARTICLE_ACCEPT）。宣言は文書の先頭にしか置けない
  const xml = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([\w.:-]+)/iu.exec(head);
  if (xml !== null) return xml[1];
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/giu)) {
    const found = CHARSET.exec(tag);
    if (found !== null) return found[1];
  }
  return null;
}
