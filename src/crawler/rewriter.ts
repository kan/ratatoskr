/**
 * HTMLRewriter の癖に対処するための小物。
 *
 * サニタイズ（sanitize.ts）・採点（extract.ts）・引用の解決（embed.ts）で
 * 共通に要るもので、どれかの責務ではない。**次に癖を踏んだときの置き場所を
 * 決めておく**ためにここへ分けてある。
 *
 * 関数にならない癖もここに書く。
 *
 * - **`.on('*')` のテキストハンドラは、要素に包まれていない直下のテキストに
 *   当たらない。** 文書全体を見るなら `.onDocument()` を使う（素のテキストを
 *   本文にするフィードで、見出しが常に空になる形で踏んだ。src/crawler/title.ts）
 */

// 記事ページ 1 枚まるごとを渡されることがある（crawler/extract.ts）。body に入るのは
// 断片なので doctype は要らない。HTMLRewriter の Doctype には remove() が無く
// ハンドラからは落とせないので、渡す前に削っておく
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

export function htmlResponse(html: string): Response {
  return new Response(html.replace(LEADING_DOCTYPE, ''), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * 開始タグで入り、終了タグで出る。**終了タグが無いなら入らなかったことにする。**
 *
 * `element.onEndTag()` は終了タグの無い要素に対して「No end tag」を投げる。
 * 空要素（`<hr>` `<br>`）だけでなく、**SVG / MathML の中では HTML と違って
 * 自己終了タグが有効**なので、`<svg class="i"/>` や `<svg><a href="#"/></svg>` が
 * 1 つ紛れているだけで走査が丸ごと落ちる（実測）。例外は crawl の
 * `Promise.allSettled` に拾われるので、**そのフィードだけ静かに全文が
 * 埋まらなくなる**。
 *
 * 握り潰すだけでは足りない。出る当てが無いまま入ると、そこから後ろが全部その
 * 要素の中の扱いになる（opaque なら以降のテキストが全て数から漏れる）。
 * **入るより先に出口を押さえる**ので、enter と leave は必ず釣り合う
 * （呼ぶ側が深さを 0 で下限クランプする必要は無い）。
 */
export function elementScope(element: Element, enter: () => void, leave: () => void): void {
  if (!onEndTag(element, leave)) return;
  enter();
}

/**
 * 終了タグに手を掛ける。掛けられたかどうかを返す。
 *
 * 「入る」動作を伴わない切れ目（段落を締めるだけの BREAK_TAGS）はこちらを使う。
 * `<hr>` のような空要素では開始タグの時点だけで用が足りる。
 */
export function onEndTag(element: Element, handler: () => void): boolean {
  try {
    element.onEndTag(handler);
    return true;
  } catch {
    return false;
  }
}
