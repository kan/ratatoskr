/**
 * 未読があることをタブのアイコンで知らせる（issue #7）。
 *
 * **バッジを重ねるのではなく、アイコンそのものを差し替える。** 32px に点や数字を
 * 載せても読めないので、未読があるときは通常のアイコン、無いときは RSS マークだけを
 * 薄いグレーに落とした版（favicon-muted）にする。明るいテーマでも暗いテーマでも
 * 沈んで見える色にしてあるので、「読むものが残っているか」だけが一目で分かる。
 *
 * 差し替える先は `web/index.html` の `<link rel="icon">`（SVG と PNG の 2 本。
 * Safari は SVG の favicon を当てにできない）。**index.html 側と同じ規則を
 * ここが持つ**ので、片方だけ増やすと差し替え漏れになる。
 *
 * 画像は SVG が正本で、PNG は SVG から起こした控え（scripts/build-icons.mjs）。
 */

/**
 * 未読の有無をアイコンに反映する。
 *
 * @param unread 全フィードの未読数の合計
 */
export function showUnread(unread: number): void {
  const has = unread > 0;

  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    const extension = link.type === 'image/svg+xml' ? 'svg' : 'png';
    const href = has ? `/favicon.${extension}` : `/favicon-muted.${extension}`;
    // 変わっていなければ触らない。差し替えるとタブがちらつく
    if (link.getAttribute('href') === href) continue;

    // **要素ごと差し替える。** href の書き換えだけでは描き直さないブラウザがある
    const next = link.cloneNode(true) as HTMLLinkElement;
    next.href = href;
    link.replaceWith(next);
  }

  setAppBadge(has);
}

/**
 * ホーム画面に追加した場合のバッジ。**対応しているブラウザだけの上乗せ**で、
 * 無くてもタブのアイコンで用は足りる。
 *
 * **件数ではなく点を出す。** 出す情報はタブのアイコンと同じ「読むものが残っているか」
 * だけにする。件数にすると記事送り 1 回ごとに値が変わり、前面に居て誰も見ていない間も
 * 打鍵のたびにブラウザへ問い合わせることになる。
 */
function setAppBadge(has: boolean): void {
  // navigator.setAppBadge は型定義に無いことがある（対応状況が分かれる）
  const badge = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };

  // 失敗しても知らせる手立ては他にある。握って続ける
  if (has) void badge.setAppBadge?.().catch(() => undefined);
  else void badge.clearAppBadge?.().catch(() => undefined);
}
