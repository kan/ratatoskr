import { elementScope, htmlResponse } from '../crawler/rewriter';
import { httpUrl } from '../crawler/url';
import { escapeHtml } from '../crawler/sanitize';
import { normalizeText } from '../crawler/title';

/**
 * メールマガジンの HTML を、読む画面に載せられる形に整える（issue #41）。
 *
 * **サニタイズの前に通す。** サニタイズは属性の多く（width / height / style）を落とすので、
 * その後では「1×1 の画像」「隠してある要素」が見分けられなくなる。ここで落とすのは
 * 見分けに属性が要るものだけで、危険なものを落とすのは従来どおりサニタイズの仕事
 * （CLAUDE.md の不変条件 4）。
 *
 * - **トラッキングピクセル**: 1×1（か 0）の画像、計測用らしい URL の画像。開封を
 *   送り手に知らせる仕掛けで、読む側には何も見えない。先読み（画像の先読みは
 *   開く前に取りに行く）が働くと、**読んでいないのに開封したことになる**
 * - **隠してある要素**: プレヘッダ（受信箱の一覧に出す一文を `display:none` で
 *   本文に埋めたもの）。サニタイズで style が落ちると本文の頭に見えてしまう
 * - **レイアウト用のテーブル**: メールの HTML は表組みで段組みを作る。そのまま
 *   描くと、行長の制限や表の罫線（読む画面の表の装飾）が段組みに掛かって崩れる。
 *   メールに本物の表はまず無いので、表の要素は全て div に読み替える
 */

const LAYOUT_TAGS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);

/** 計測用の画像らしい URL。開封の通知を返すサービスの定番の形 */
const TRACKING_SRC =
  /(\/open(\.gif|\.png)?[/?]|\/track(ing)?\/|\/pixel|\/beacon|\/o\.gif|wf\/open)/i;

/** 隠してある要素の style */
const HIDDEN_STYLE =
  /(display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|mso-hide\s*:\s*all)/i;

/** 「Web 版で読む」リンクの文言 */
const WEB_VERSION =
  /(ブラウザ(で|で見る|で表示|で読む)|web\s*版|ウェブ版|オンラインで|view\s+(this\s+)?(email\s+)?(it\s+)?(in|on)\s+(your\s+)?(web\s+)?browser|view\s+online|read\s+online|open\s+in\s+browser)/i;

export interface CleanedMail {
  html: string;
  /** 「Web 版で読む」のリンク先。記事の URL にする（無ければ null） */
  webUrl: string | null;
}

/**
 * クリックの計測を挟んだリンクを、本来の行き先に戻す。
 *
 * Amazon SES のクリック計測は `https://<配信元>/CL0/<エンコードした行き先>/1/<id>/<署名>` の
 * 形にリンクを書き換える（theLetter が実際にこれだった）。**戻さないと、読む画面で
 * リンクを開くたびに送り手へクリックが知らされる。** 保存する URL も本来のものにしたい
 * （記事の URL・ピン・リンク一覧）。行き先が http(s) でなければ書き換えない
 */
export function unwrapTrackedLink(href: string): string {
  const url = httpUrl(href);
  const match = url === null ? null : /^\/CL\d\/([^/]+)\//.exec(url.pathname);
  if (match === null) return href;
  let target: string;
  try {
    target = decodeURIComponent(match[1]);
  } catch {
    return href;
  }
  return httpUrl(target)?.href ?? href;
}

/**
 * @param subject 件名。「ブラウザで見る」が無いメールでは、**件名と同じ文字のリンク**を
 *   Web 版とみなす（theLetter は見出しが Web 版の記事へのリンクになっている）
 */
export async function cleanMailHtml(html: string, subject = ''): Promise<CleanedMail> {
  let webUrl: string | null = null;
  let titleUrl: string | null = null;
  const title = normalizeText(subject);
  let pendingHref: string | null = null;
  let pendingText = '';

  const rewriter = new HTMLRewriter()
    .on('img', {
      element(element) {
        const width = dimension(element.getAttribute('width'));
        const height = dimension(element.getAttribute('height'));
        const tiny = (width <= 2 && width >= 0) || (height <= 2 && height >= 0);
        const src = element.getAttribute('src') ?? '';
        // 隠してある画像は下の `*` が落とす
        if (tiny || TRACKING_SRC.test(src)) element.remove();
      },
    })
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (HIDDEN_STYLE.test(element.getAttribute('style') ?? '')) {
          element.remove();
          return;
        }
        if (LAYOUT_TAGS.has(tag)) element.tagName = 'div';
      },
      // リンクの文字は中の要素（`<span>`）に入っていることが多いので、`*` で拾う
      text(chunk) {
        if (pendingHref !== null && pendingText.length < 200) pendingText += chunk.text;
      },
    })
    .on('a[href]', {
      element(element) {
        const raw = element.getAttribute('href');
        if (raw === null) return;
        const href = unwrapTrackedLink(normalizeText(raw));
        if (href !== normalizeText(raw)) element.setAttribute('href', href);
        if (webUrl !== null) return;
        elementScope(
          element,
          () => {
            pendingHref = href;
            pendingText = '';
          },
          () => {
            const text = normalizeText(pendingText);
            if (webUrl === null && WEB_VERSION.test(text)) {
              webUrl = httpUrl(href)?.href ?? null;
            } else if (titleUrl === null && title !== '' && text === title) {
              titleUrl = httpUrl(href)?.href ?? null;
            }
            pendingHref = null;
          },
        );
      },
    });

  const out = await rewriter.transform(htmlResponse(html)).text();
  // 「ブラウザで見る」が見つかればそちらを優先する。見出しのリンクは、同じ文字の
  // 別の記事（過去の号の紹介）を指していることがあるので、あくまで代わり
  return { html: out, webUrl: webUrl ?? titleUrl };
}

/**
 * img の width / height を数にする。指定が無い・空・数でないときは NaN。
 *
 * `Number('')` は 0 になるので、そのまま使うと `width=""` の画像（配信ツールが
 * よく出す）を 1×1 のトラッキングピクセルと取り違えて消す
 */
function dimension(value: string | null): number {
  if (value === null || value.trim() === '') return NaN;
  return Number(value);
}

/** テキストだけのメールを HTML にする。空行で段落を分け、行の折り返しは残す */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
}
