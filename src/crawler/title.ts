/**
 * タイトルを配らないフィードのために、本文から見出しを作る
 * （`docs/DESIGN.md` の「タイトルを配らないフィード」）。
 */

import { htmlResponse } from './rewriter';

/**
 * 見出しに使う長さ。
 *
 * 左ペインは 1 行に収めて溢れを CSS で切るので、ここは記事ビューの見出しに
 * 収まる長さで決める。日本語で 60 字あれば、Bluesky の投稿なら 1 文めか
 * 「今日の体重: 133.4kg (BMI: 38.56) 体脂肪率: 32.49%」のような 1 行が丸ごと入る。
 */
const MAX_LENGTH = 60;

/**
 * 段落の切れ目。**間に空白を挟むために見る。**
 *
 * 挟まないと `<p>ひとつ目</p><p>ふたつ目</p>` が「ひとつ目ふたつ目」になる。
 * インライン要素（`a` / `strong`）で挟むと、日本語の文の途中に空白が入って
 * かえって読みにくいので、ブロック要素だけを見る。
 *
 * **渡ってくるのはサニタイズ済みの本文**なので、sanitize.ts の ALLOWED_TAGS に
 * 無いタグ（`header` / `nav` / `form` 等）は原理的に来ない。採点側の一覧
 * （src/crawler/extract.ts の BREAK_TAGS）に並ぶそれらがここに無いのはそのため
 */
const BLOCK_TAGS =
  'p, div, br, hr, li, dt, dd, h1, h2, h3, h4, h5, h6, tr, blockquote, pre, figure, figcaption';

/**
 * 溜める文字数の上限。
 *
 * 見出しに使うのは先頭 60 字だけなので、本文全体を組み立てる意味が無い
 * （全文取得を入れたフィードの本文は数十 KB になる）。実体参照は解くと縮み
 * （`&#128512;` の 10 文字が 2 文字）、空白も畳むと縮むので、上限には 60 字ぶんに
 * 十分な余裕を取ってある。採点側の書き出し（extract.ts の PREVIEW_LENGTH）と同じ抑え方
 */
const COLLECT_LIMIT = MAX_LENGTH * 16;

/**
 * サニタイズ済みの本文から見出しを作る。作れなければ空文字（呼び出し側が
 * 「(無題)」を出す）。
 *
 * 作るのは**本文の書き出し**。要約や言い換えは作らない——読む前に見えているものと
 * 開いた中身が食い違うため。空白（改行を含む）は 1 つに畳み、**行では切らない**
 * （1 行目が極端に短い本文で見出しが用を成さなくなる）。
 */
export async function titleFromBody(html: string): Promise<string> {
  let collected = '';

  await new HTMLRewriter()
    .on(BLOCK_TAGS, {
      element() {
        if (collected.length < COLLECT_LIMIT) collected += ' ';
      },
    })
    // **`.on('*')` ではなく文書のハンドラで拾う。** 要素に包まれていない
    // 直下のテキストは `*` に当たらない（実測）。Bluesky の description は
    // まさに素のテキストなので、`*` で拾うと見出しが常に空になる
    .onDocument({
      text(chunk) {
        if (collected.length < COLLECT_LIMIT) collected += chunk.text;
      },
    })
    .transform(htmlResponse(html))
    .arrayBuffer();

  // 実体参照を戻してから空白を畳む。`&nbsp;` は畳んだ先で普通の空白になる
  const text = decodeEntities(collected).replace(/\s+/gu, ' ').trim();
  // **切るのはコードポイント単位。** slice は UTF-16 の単位で切るので、境目に
  // 絵文字が来るとサロゲートペアが割れ、画面には U+FFFD が出る。Bluesky のような
  // 短文の投稿が主な対象なので、絵文字が境目に来る率は低くない
  const points = [...text];
  return points.length <= MAX_LENGTH ? text : `${points.slice(0, MAX_LENGTH).join('')}…`;
}

/**
 * 実体参照を文字に戻す。
 *
 * **本文は HTML だが、見出しはテキストとして描かれる。** `v-html` で描かれる本文と
 * 違って、戻さないと `A &amp; B` が画面にそのまま出る。HTMLRewriter のテキストは
 * 生のソースなので、実体参照は解かれないまま来る（実測）。
 *
 * 表が短いのは意図的。フィードの本文は取り込み時に fast-xml-parser が 1 度
 * 解いている（src/crawler/xml.ts）ので、ここまで残るのは **二重にエスケープ
 * されていたもの**——つまりサニタイザや配信側が書き出す定番の数個だけ。
 * HTML5 の表は 2000 件を超えるが、それを持ち込む理由が無い。知らない名前は
 * そのまま残す（消すより、字面が出た方が読み手には分かる）。
 *
 * **画面側にも同じ物がある**（`web/src/lib/prefetch.ts` の decodeCharRefs）。
 * あちらは属性値の URL 用で、名前付きの表がさらに短い。片方だけ直さないこと
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, ref: string) => {
    if (!ref.startsWith('#')) return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;

    const code =
      ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    // 単独のサロゲートを作らない。作ると、割れたペアと同じく U+FFFD になる
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}
