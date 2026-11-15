/**
 * UTF-8 以外の HTML を組み立てる小物（src/crawler/charset.ts の周りのテスト用）。
 * TextEncoder は UTF-8 しか書けないので、日本語の部分はバイト列で渡す。
 */

/** ASCII の部分を素のバイトに、日本語の部分を与えたバイト列にして連結する */
export function bytesOf(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...new TextEncoder().encode(part));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

/** 「日本語」の Shift_JIS */
export const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
/** 「日本語」の EUC-JP */
export const EUCJP_NIHONGO = [0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec];
