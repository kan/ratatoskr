import { BOOKMARK_KEY, readPref, writePref } from '@/lib/prefs';

/**
 * 外部ブックマークへ記事を送る（issue #22。仕様は docs/UX.md の「外部ブックマーク」）。
 *
 * **相手の投稿画面を新しいタブで開くだけ。** API で直接投稿する形にしなかったのは、
 * 秘密値とサーバ側の送信経路が要るうえ、コメントやタグを付けられなくなるため
 * （はてなブックマークの API は OAuth 1.0a しか受けない）。開く形なら、ブラウザの
 * ログイン済みセッションがそのまま使え、送り先を選ばない。
 *
 * 送り先は URL のひな形で持つ。`{url}` と `{title}` を記事のものに差し替える。
 */

/**
 * 既定の送り先（はてなブックマーク）。公式のブックマークレットが開くのと同じ入口。
 * タイトルは相手がページから採るので渡さない
 */
export const DEFAULT_BOOKMARK_TEMPLATE = 'https://b.hatena.ne.jp/my/add.confirm?url={url}';

const URL_SLOT = '{url}';

/** http / https の URL として読めればそれを、読めなければ null を返す */
function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * ひな形として使えるか。`{url}` が無いものは、何を送っても同じ画面が開くだけになる。
 *
 * http / https に限るのは、ここに入れた文字列がそのまま window.open に渡るため
 * （`javascript:` を通すと、設定欄がスクリプトの実行口になる）。
 *
 * **中身のあるタイトルで埋めて確かめる。** 空のタイトルで試すと、`{title}` を
 * スキームやポートの位置に置いたひな形が通り、実際の記事で初めて壊れる
 */
export function isBookmarkTemplate(template: string): boolean {
  return template.includes(URL_SLOT) && fill(template, 'https://example.com/', 'x y') !== null;
}

/**
 * ひな形を埋める。**埋めた結果が http / https の URL にならなければ null。**
 * 保存時の検査は 1 例を試すだけなので、開く直前にも結果そのものを確かめる
 */
function fill(template: string, url: string, title: string): string | null {
  try {
    // 一度に置き換える。順に replaceAll すると、タイトルに「{url}」と書いてある記事で
    // 差し込んだ後の文字列がもう一度置き換わる
    const filled = template.replace(/\{url\}|\{title\}/g, (slot) =>
      encodeURIComponent(slot === URL_SLOT ? url : title),
    );
    return httpUrl(filled) === null ? null : filled;
  } catch {
    // encodeURIComponent は、対になっていないサロゲート（絵文字の途中で切られた
    // タイトルなど）で URIError を投げる。投げたままにすると、押しても何も起きない
    return null;
  }
}

/** この端末の送り先。変えていなければ既定 */
export function bookmarkTemplate(): string {
  const saved = readPref(BOOKMARK_KEY);
  return saved !== null && isBookmarkTemplate(saved) ? saved : DEFAULT_BOOKMARK_TEMPLATE;
}

/**
 * 送り先を覚える。空にすると既定に戻す。
 *
 * @returns 結果。`invalid` はひな形として使えない、`unsaved` は端末が覚えられなかった
 *   （プライベートウィンドウや保存を止めた設定では localStorage に書けない）
 */
export function saveBookmarkTemplate(value: string): 'saved' | 'invalid' | 'unsaved' {
  const template = value.trim() || DEFAULT_BOOKMARK_TEMPLATE;
  if (!isBookmarkTemplate(template)) return 'invalid';

  writePref(BOOKMARK_KEY, template === DEFAULT_BOOKMARK_TEMPLATE ? null : template);
  // 書けたかは読み戻して確かめる。writePref は失敗を握りつぶす
  return bookmarkTemplate() === template ? 'saved' : 'unsaved';
}

/**
 * 記事を送るために開く URL。送れないときは null。
 *
 * 記事の URL はフィードが配ったものなので、http / https であることを確かめ、
 * 正規化した形で渡す（前後に空白や改行が付いたまま配るフィードがある）
 */
export function bookmarkUrl(template: string, url: string, title: string): string | null {
  const target = httpUrl(url);
  return target === null ? null : fill(template, target.href, title);
}
