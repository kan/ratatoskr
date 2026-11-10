/**
 * URL の正規化。**ピンの同一性はこの形で決まる**（stores/pins.ts）。サーバは
 * new URL().href で控えて返すので（src/api/pins.ts）、手元でも同じ形にしないと、
 * 同じ URL が「別のピン」に見える。ピンと照らし合わせる側（lib/links.ts）も必ずこれを通す
 */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** http / https の URL なら正規化した形を、そうでなければ null を返す */
export function httpHref(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}
