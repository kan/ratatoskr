/**
 * 見ているサイトをその場で購読する導線（issue #4）。
 *
 * ブックマークレットから `https://<リーダー>/?add=<いま見ているページの URL>` を開き、
 * 起動した画面が購読管理を開いてそのまま登録する。
 *
 * **他のサイトから API を直接叩かせない。** `fetch` では CORS と Cloudflare Access の
 * 両方に阻まれるうえ、通すには資格情報を配ることになる。画面を開く形なら、Access の
 * ログイン済みセッションがそのまま使え、ブックマークレット側は 1 行で済む。
 *
 * フィードの探索はサーバに任せる（`POST /api/feeds`。M5）。ページの `<link rel=alternate>`
 * をブックマークレット側で読んで渡す手もあるが、探索の規則が 2 箇所に分かれる。
 */

/** 購読したいページの URL を載せる検索パラメータ */
export const ADD_PARAM = 'add';

/**
 * ブックマークレットから渡された URL。無ければ null。
 *
 * http / https 以外は捨てる。ブックマークレットが渡すのは見ているページの URL だが、
 * このパラメータは誰でも付けられるので、そのまま登録の入力にしない
 */
export function pendingSubscription(search: string): string | null {
  const value = new URLSearchParams(search).get(ADD_PARAM);
  if (value === null || value.trim() === '') return null;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * ブックマークバーに入れる 1 行。リーダー自身の出どころから組み立てるので、
 * ホスト名を手で書き写す必要がない。
 *
 * 新しいタブで開く。読んでいたページから離れずに登録できる方が、拾ったその場で
 * 押せる（開けなかったときだけ今のタブで開く）
 */
export function bookmarkletFor(origin: string): string {
  const target = `${origin}/?${ADD_PARAM}=`;
  return `javascript:(function(){var u='${target}'+encodeURIComponent(location.href);if(!window.open(u,'_blank'))location.href=u;})();`;
}
