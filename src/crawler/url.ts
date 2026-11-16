/**
 * URL の小物。クローラが外から来た URL を扱うときの共通の判定を置く。
 * （画面側の同じものは web/src/lib/url.ts の httpHref）
 */

/**
 * http / https の URL なら絶対 URL にして返す。それ以外（javascript: や mailto:、
 * 読めないもの）は null。`base` を渡せば相対 URL を解く
 */
export function httpUrl(value: string, base?: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/** www の有無を無視したホスト名。同じサイトかどうかの判定に使う */
export function siteName(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}
