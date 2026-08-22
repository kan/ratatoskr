/**
 * 記事ページから本文らしい部分を取り出す（M7 の全文取得）。
 *
 * 要約しか配信しないフィードが現実に多い（テクノエッジは description 100 字ほどで、
 * 本文も画像も記事ページ側にある）。画像の先読みは先読みする画像が無ければ効かないので、
 * 「読む前に手元へ落としておく」仕事として全文取得と一緒に扱う（docs/ROADMAP.md M7）。
 *
 * ここの仕事は「本文の候補になる要素を数え上げること」だけ。AI に見せるのはこの一覧で、
 * HTML そのものではない（記事ページは 80KB を超え、コンテキストにも乗らない）。
 * 決まったセレクタで実際に本文を切り出すのは sanitize.ts の sanitizeWithin。
 *
 * HTMLRewriter で済ませている。Workers に DOMParser は無く、木を組み立てる
 * ライブラリを持ち込むほどの仕事でもない。
 */

import { htmlResponse } from './sanitize';

/**
 * 本文の入れ物になりうるタグ。段落そのもの（p）は入れない。
 * 入れ物を選ぶのが目的で、段落は入れ物を採点するための材料に使う。
 */
const CANDIDATE_TAGS = 'article, main, section, div, td';

/** 中のテキストを数えないタグ。読める文章ではない */
const OPAQUE_TAGS = 'script, style, noscript, template, title, svg, head';

/**
 * 採点に数える段落の最短の長さ。
 * Readability と同じ考え方で、これ未満はナビゲーションや注釈とみなす。
 */
const MIN_PARAGRAPH = 25;

/** AI に渡す書き出しの長さ */
const PREVIEW_LENGTH = 80;

export interface Candidate {
  /** HTMLRewriter で引ける形のセレクタ。文書内で一意なものだけを返す */
  selector: string;
  /** 空白を除いた文字数 */
  text: number;
  /** そのうちリンクの中にあった文字数 */
  link: number;
  /** 本文らしさ。大きいほど本文らしい */
  score: number;
  /** 書き出し。AI が「これは関連記事の一覧ではないか」を判断する手がかりになる */
  preview: string;
}

interface OpenNode {
  tag: string;
  classes: string[];
  id: string | null;
  text: number;
  link: number;
  /** 段落から配られた点。直接の子には満額、孫には半額（後述） */
  paragraph: number;
  preview: string;
}

/**
 * 本文の候補を採点して返す。点の高い順。
 *
 * 採点は Readability の考え方をそのまま小さくしたもの。**段落の長さを、その段落を
 * 直接抱えている入れ物に満額、その 1 つ上に半額だけ配る。** 2 段までで打ち切るのが
 * 肝で、これが無いとページ全体を包んでいる div が必ず 1 位になる（実測した:
 * テクノエッジの記事ページは単純なテキスト量ではページ全体を包む div が最大で、
 * 本文の article は 6 位だった）。
 *
 * そのうえでリンク率で割り引く。関連記事の一覧やサイドバーは文字数こそ多いが、
 * そのほとんどがリンクの中にある。
 */
export async function scanCandidates(html: string): Promise<Candidate[]> {
  /** いま開いている候補。末尾が最も内側 */
  const open: OpenNode[] = [];
  const closed: OpenNode[] = [];
  /** 同じセレクタを持つ要素の数。2 以上のものは名指しできないので捨てる */
  const selectorCount = new Map<string, number>();

  let opaqueDepth = 0;
  let linkDepth = 0;
  let inParagraph = false;
  /** いま開いている段落の文字数 */
  let paragraphText = 0;

  /**
   * 開いている段落を締めて加点する。
   *
   * **`</p>` を当てにしない。** HTML5 では p の終了タグを省いてよく（次のブロックが
   * 始まった時点で閉じる）、実際に省くサイトがある。HTMLRewriter は木を組み立てない
   * ので暗黙の終了タグはほとんど飛んで来ず、`</p>` だけを頼りにすると加点が丸ごと
   * 落ちる。blog.jxck.io の記事ページで候補が 1 つも出ない形で踏んだ。
   *
   * 代わりに「次の段落が始まったとき」「入れ物が開いた / 閉じたとき」に締める。
   * どの時点でも、加点先は**そのとき開いている入れ物**なので取り違えない。
   */
  function creditParagraph(): void {
    const text = paragraphText;
    paragraphText = 0;
    inParagraph = false;
    if (text < MIN_PARAGRAPH) return;

    // 直接の入れ物に満額、その 1 つ上に半額。3 つ上には配らない
    const parent = open[open.length - 1];
    const grandparent = open[open.length - 2];
    if (parent !== undefined) parent.paragraph += text;
    if (grandparent !== undefined) grandparent.paragraph += text / 2;
  }

  await new HTMLRewriter()
    .on(OPAQUE_TAGS, {
      element(element) {
        opaqueDepth += 1;
        element.onEndTag(() => {
          opaqueDepth = Math.max(0, opaqueDepth - 1);
        });
      },
    })
    .on(CANDIDATE_TAGS, {
      element(element) {
        // 入れ物の切れ目は段落の切れ目でもある。開く前に締めておかないと、
        // ここまでの文字が中の入れ物に加点されてしまう
        creditParagraph();
        const node: OpenNode = {
          tag: element.tagName.toLowerCase(),
          classes: classList(element.getAttribute('class')),
          id: element.getAttribute('id'),
          text: 0,
          link: 0,
          paragraph: 0,
          preview: '',
        };
        countSelector(selectorCount, node);
        open.push(node);
        element.onEndTag(() => {
          // 閉じる前に締める。順序を逆にすると、最後の段落が 1 つ外側に加点される
          creditParagraph();
          const index = open.lastIndexOf(node);
          if (index === -1) return;
          open.splice(index, 1);
          closed.push(node);
        });
      },
    })
    .on('a', {
      element(element) {
        linkDepth += 1;
        element.onEndTag(() => {
          linkDepth = Math.max(0, linkDepth - 1);
        });
      },
    })
    .on('p', {
      element(element) {
        // 前の段落が閉じられていなければ、ここで閉じたものとして締める
        creditParagraph();
        inParagraph = true;
        element.onEndTag(() => {
          creditParagraph();
        });
      },
    })
    .on('*', {
      text(chunk) {
        if (opaqueDepth > 0) return;
        const length = chunk.text.trim().length;
        if (length === 0) return;

        for (const node of open) {
          node.text += length;
          if (linkDepth > 0) node.link += length;
          if (node.preview.length < PREVIEW_LENGTH && linkDepth === 0) {
            node.preview = (node.preview + chunk.text.trim()).slice(0, PREVIEW_LENGTH);
          }
        }
        if (inParagraph) paragraphText += length;
      },
    })
    .transform(htmlResponse(html))
    .arrayBuffer();

  // 文書の終わりで開いたままの段落も締める（入れ物ごと閉じられていないページ）
  creditParagraph();

  // 閉じられなかった要素（不正な HTML）も候補には入れる
  const nodes = [...closed, ...open];

  return nodes
    .map((node) => toCandidate(node, selectorCount))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.score - a.score);
}

function toCandidate(node: OpenNode, selectorCount: Map<string, number>): Candidate | null {
  if (node.text === 0 || node.paragraph === 0) return null;

  const selector = selectorOf(node);
  // 名指しできないものは、後で同じ場所を引ける保証が無いので候補にしない
  if (selector === null || (selectorCount.get(selector) ?? 0) !== 1) return null;

  // リンク率で割り引く。関連記事の一覧は文字数の割に本文らしくない
  const linkDensity = Math.min(1, node.link / node.text);
  return {
    selector,
    text: node.text,
    link: node.link,
    score: Math.round(node.paragraph * (1 - linkDensity)),
    preview: node.preview,
  };
}

function classList(value: string | null): string[] {
  if (value === null) return [];
  // HTMLRewriter が引ける形にする。数字始まりなどエスケープが要る class は捨てる
  return value.split(/\s+/).filter((name) => /^[A-Za-z_-][\w-]*$/.test(name));
}

/**
 * 要素を名指しするセレクタ。id があればそれだけで足り、無ければタグと class を全部並べる。
 * class を絞らないのは、`article.pickup-content` のように同じ class の要素が
 * ページ内に何度も出てくるため（テクノエッジの関連記事がまさにこれ）。
 */
function selectorOf(node: OpenNode): string | null {
  // id にもタグ名を付ける。一意かどうかを数えているのは候補のタグだけなので、
  // <h1 id="content"> のように候補でない要素が同じ id を持つと、一意と誤って
  // 数えたうえで先に出てくる方（見出し）を掴んでしまう
  if (node.id !== null && /^[A-Za-z_-][\w-]*$/.test(node.id)) return `${node.tag}#${node.id}`;
  if (node.classes.length > 0) return node.tag + node.classes.map((name) => `.${name}`).join('');

  // **class も id も持たない素の HTML はタグ名で名指しする。** class を全く使わない
  // サイトがある（blog.jxck.io は article / section だけで組まれていて、名前が付けられず
  // 候補が 1 つも出なかった）。文書内に 1 つしか無いことは呼び出し側が確かめるので、
  // 残るのは article や main のように 1 つしかない入れ物だけになる
  return node.tag;
}

function countSelector(counts: Map<string, number>, node: OpenNode): void {
  const selector = selectorOf(node);
  if (selector === null) return;
  counts.set(selector, (counts.get(selector) ?? 0) + 1);
}
