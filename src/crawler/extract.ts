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

import { elementScope, htmlResponse, onEndTag } from './rewriter';

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

/**
 * 段落の切れ目になるタグ。ブロック要素は段落を切る、という一般則で選んである。
 *
 * **`<p>` だけを見ていると、`<p>` を使わずに本文を書くサイトで加点が丸ごと落ちる。**
 * 虚構新聞は article 直下に素のテキストを置き、改行は br だけで作っている。
 * `<p>` もこの一員（段落の切れ目であることに変わりはない）。
 *
 * br だけは別扱いにする（softBreak）。
 *
 * `hr` のような空要素も混ざる。終了タグが無いので締めるのは開いた時点だけになるが、
 * それで足りる（rewriter.ts の onEndTag）。
 */
const BREAK_TAGS =
  'p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre, figcaption, dt, dd, figure, hr, header, footer, nav, aside, address, form';

/**
 * 段落と認めるリンク率の上限。**これを超える塊はナビゲーションとみなして数えない。**
 * 本文の中の語へのリンクが半分を超えることはない
 */
const MAX_PARAGRAPH_LINK_SHARE = 0.5;

/** AI に渡す書き出しの長さ */
const PREVIEW_LENGTH = 80;

/**
 * 本文と認めるのに要る、その記事の段落に占める割合。
 *
 * **外枠を本文として掴む事故を止めるための下限。** 結城浩の日記では、候補が
 * 著者プロフィールの 1 つだけになり（本文の入れ物は一意に名指しできず落ちる）、
 * それが全記事の本文として保存された。プロフィールは記事の文章の 1% にも満たない。
 *
 * 低めに置いてある。本文が複数の入れ物に分かれて書かれるサイトでも、その 1 つが
 * 1 割は持つ。全て下回れば候補は 0 件になり、全文取得を見送って要約のまま残す
 */
const MIN_BODY_SHARE = 0.1;

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
  /** フラグメントで絞った対象の中にあるか。絞っていないときは使われない */
  scoped: boolean;
}

export interface ScanOptions {
  /**
   * 記事 URL の `#` 以下。**1 ページに複数の記事が並ぶ日記型のサイトでは、どの記事かを
   * これが決める。** 渡すと、そのアンカーを含む入れ物の中だけを候補として数える。
   *
   * 結城浩の日記（d.hyuki.com）は月別アーカイブ 1 ページに 1 か月分の記事が並ぶ。
   * 本文の入れ物 `div.DIARY-CONTENT` はページ内に 11 個あって一意に名指しできず、
   * 文書全体を見ると候補は著者プロフィールの外枠しか残らなかった
   */
  fragment?: string | null;
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
export async function scanCandidates(
  html: string,
  options: ScanOptions = {},
): Promise<Candidate[]> {
  const fragment = normalizeFragment(options.fragment ?? null);

  /** いま開いている候補。末尾が最も内側 */
  const open: OpenNode[] = [];
  const closed: OpenNode[] = [];
  /** フラグメントが指す記事の入れ物。null なら文書全体が対象 */
  let scope: OpenNode | null = null;
  /** その入れ物の中にいるか。開いた記事の外に出たら倒す */
  let inScope = false;
  /** 採点の分母。対象が決まった時点で 0 に戻すので、常に「対象の中の総量」 */
  let paragraphTotal = 0;

  let opaqueDepth = 0;
  let linkDepth = 0;
  /** いま開いている段落の文字数 */
  let paragraphText = 0;
  /** そのうちリンクの中にあった文字数 */
  let paragraphLink = 0;

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
    const link = paragraphLink;
    paragraphText = 0;
    paragraphLink = 0;
    if (text < MIN_PARAGRAPH) return;
    // **リンクばかりの塊は段落として数えない。** ナビゲーションや関連記事の一覧は
    // li で組まれているとは限らず、素のリンクが並ぶだけのこともある。それを数えると
    // 分母（paragraphTotal）が膨らみ、本文が下限に切られて候補から落ちる。
    //
    // 丸ごと捨てるのは、toCandidate のリンク率による比例割引と違って**採点を動かさない**
    // ため。割引の形にすると `<p>` で書かれた既存のサイトの点数まで全て変わる
    if (link >= text * MAX_PARAGRAPH_LINK_SHARE) return;

    if (scope === null || inScope) paragraphTotal += text;

    // 直接の入れ物に満額、その 1 つ上に半額。3 つ上には配らない
    const parent = open[open.length - 1];
    const grandparent = open[open.length - 2];
    if (parent !== undefined) parent.paragraph += text;
    if (grandparent !== undefined) grandparent.paragraph += text / 2;
  }

  /**
   * br による改行。**溜まりが段落と呼べる長さに達していなければ締めない。**
   *
   * br は他の切れ目と違って、1 つの段落の中の改行にも使われる。1 行が短い書き方
   * （詩や箇条書き風の日記）で毎回締めると、全ての行が MIN_PARAGRAPH に届かず
   * 加点が丸ごと落ちる。長い行はそのまま割れるので、区切りとしては効いたまま
   */
  function softBreak(): void {
    if (paragraphText >= MIN_PARAGRAPH) creditParagraph();
  }

  const rewriter = new HTMLRewriter()
    .on(OPAQUE_TAGS, {
      element(element) {
        elementScope(
          element,
          () => {
            opaqueDepth += 1;
          },
          () => {
            opaqueDepth -= 1;
          },
        );
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
          // 対象が決まった後に開いた入れ物は、その中にある
          scoped: inScope,
        };
        elementScope(
          element,
          () => {
            open.push(node);
          },
          () => {
            // 閉じる前に締める。順序を逆にすると、最後の段落が 1 つ外側に加点される
            creditParagraph();
            if (node === scope) inScope = false;
            const index = open.lastIndexOf(node);
            if (index === -1) return;
            open.splice(index, 1);
            closed.push(node);
          },
        );
      },
    })
    .on('a', {
      element(element) {
        elementScope(
          element,
          () => {
            linkDepth += 1;
          },
          () => {
            linkDepth -= 1;
          },
        );
      },
    })
    .on(BREAK_TAGS, {
      element(element) {
        // 前の段落が閉じられていなければ、ここで閉じたものとして締める
        creditParagraph();
        onEndTag(element, () => {
          creditParagraph();
        });
      },
    })
    .on('br', {
      element() {
        softBreak();
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
        paragraphText += length;
        if (linkDepth > 0) paragraphLink += length;
      },
    });

  if (fragment !== null) {
    // **候補の登録より後に足す。** アンカーが入れ物そのものに付いている場合
    // （`<div id="p01" class="section">`）に、その入れ物自身を対象にできる。
    // ここで決める「アンカーを抱えている最も内側の入れ物」が対象の定義で、
    // locateFragmentOccurrence も同じ規則で範囲を決める（規則がずれると、
    // A の記事から選んだセレクタを B の記事の位置で切り出すことになる）
    rewriter.on(anchorSelector(fragment), {
      element() {
        if (scope !== null) return;
        const holder = open[open.length - 1];
        if (holder === undefined) return;
        scope = holder;
        holder.scoped = true;
        inScope = true;
        // ここから先が対象。分母を「対象の中の段落」に取り直す
        paragraphTotal = 0;
      },
    });
  }

  await rewriter.transform(htmlResponse(html)).arrayBuffer();

  // 文書の終わりで開いたままの段落も締める（入れ物ごと閉じられていないページ）
  creditParagraph();

  // 閉じられなかった要素（不正な HTML）も候補には入れる
  const nodes = [...closed, ...open].filter((node) => scope === null || node.scoped);

  /**
   * 同じセレクタを持つ要素の数。2 以上のものは名指しできないので捨てる。
   * **数えるのは対象の中だけ。** 日記型のサイトでは、記事の外まで数えると
   * 本文の入れ物が必ず複数になって候補から落ちる（どの記事かはフラグメントが
   * 決めるので、記事の中で一意なら sanitizeWithin が同じ場所を引ける）
   */
  // **絞ったときは id を使わない。** 繰り返し構造の中の id は記事ごとに違うので
  // （`<div id="p01">` / `<div id="p02">`）、それをフィード全体のセレクタとして
  // 覚えると他の記事が全て当たらなくなり、毎クロール判定し直す空回りになる
  const useId = scope === null;
  const selectorCount = new Map<string, number>();
  for (const node of nodes) {
    const selector = selectorOf(node, useId);
    if (selector === null) continue;
    selectorCount.set(selector, (selectorCount.get(selector) ?? 0) + 1);
  }

  // 本文は、その記事にある文章の大半を占める。ごく一部しか持たない入れ物を
  // 1 位にすると、著者プロフィールのような外枠を本文として掴む（実際に踏んだ）。
  // 全て下回るなら候補は 0 件になり、呼び出し側は全文取得を見送る
  const floor = paragraphTotal * MIN_BODY_SHARE;

  return nodes
    .map((node) => toCandidate(node, selectorCount, useId))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .filter((candidate) => candidate.score >= floor)
    .sort((a, b) => b.score - a.score);
}

function toCandidate(
  node: OpenNode,
  selectorCount: Map<string, number>,
  useId: boolean,
): Candidate | null {
  if (node.text === 0 || node.paragraph === 0) return null;

  const selector = selectorOf(node, useId);
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
function selectorOf(node: OpenNode, useId = true): string | null {
  // id にもタグ名を付ける。一意かどうかを数えているのは候補のタグだけなので、
  // <h1 id="content"> のように候補でない要素が同じ id を持つと、一意と誤って
  // 数えたうえで先に出てくる方（見出し）を掴んでしまう
  if (useId && node.id !== null && /^[A-Za-z_-][\w-]*$/.test(node.id)) {
    return `${node.tag}#${node.id}`;
  }
  if (node.classes.length > 0) return node.tag + node.classes.map((name) => `.${name}`).join('');

  // **class も id も持たない素の HTML はタグ名で名指しする。** class を全く使わない
  // サイトがある（blog.jxck.io は article / section だけで組まれていて、名前が付けられず
  // 候補が 1 つも出なかった）。文書内に 1 つしか無いことは呼び出し側が確かめるので、
  // 残るのは article や main のように 1 つしかない入れ物だけになる
  return node.tag;
}

/**
 * 記事 URL の `#` 以下を取り出す。無ければ null。
 *
 * 日記型のサイトは 1 ページに複数の記事が並び、**どの記事かはここが決める**
 * （`https://d.hyuki.com/202509.html#i20250924072819`）。
 */
export function fragmentOf(url: string): string | null {
  const hash = url.indexOf('#');
  if (hash === -1) return null;
  const fragment = url.slice(hash + 1);
  return fragment === '' ? null : fragment;
}

/**
 * 属性セレクタにそのまま埋められる形だけを通す。
 *
 * `%E3%81%82` のように符号化された形で来ることがあるので戻してから見る。
 * 引用符やバックスラッシュを含むものは、セレクタを組み立てる側で壊れるので捨てる
 * （捨てても文書全体を見る従来の動きに落ちるだけで、悪くはならない）。
 */
function normalizeFragment(fragment: string | null): string | null {
  if (fragment === null || fragment === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  return /^[\w.:-]+$/.test(decoded) ? decoded : null;
}

/** 古い日記系は `<a name="...">`、新しいものは id。どちらも見る */
function anchorSelector(fragment: string): string {
  return `[id="${fragment}"], [name="${fragment}"]`;
}

/**
 * セレクタに当たる何番目の要素が、そのフラグメントの記事のものかを返す。
 *
 * **1 ページに複数の記事が並ぶサイトのため。** 覚えたセレクタ（`div.DIARY-CONTENT`）は
 * ページ内で何度も当たるので、番号で選ばないと必ず 1 件目の本文になる。
 *
 * 探す範囲は**アンカーを抱えている入れ物の中だけ**に限る。「アンカーより後の最初の
 * 一致」で済ませると、記事の末尾にパーマリンクを置く作りで隣の記事の本文を採る
 * （エラーにならず、他人の本文が静かに保存される）。入れ物の中に一致が無ければ
 * null を返し、呼び出し側は従来どおり 1 件目を使う。
 *
 * 一致がアンカーの前にあっても後にあっても採れる。前者は記事の末尾にアンカーを置く形、
 * 後者は結城浩の日記（`<article><h2><a id="i2025…"></a></h2><div class="DIARY-CONTENT">`）。
 */
export async function locateFragmentOccurrence(
  html: string,
  selector: string,
  fragment: string,
): Promise<number | null> {
  const safe = normalizeFragment(fragment);
  if (safe === null) return null;

  /**
   * いま開いている入れ物。`matchesBefore` は「その入れ物が開いた時点で、
   * セレクタに当たった数」。**対象の中の一致は、この数以降に並ぶ。**
   */
  const openBoxes: { matchesBefore: number }[] = [];
  let matchCount = 0;
  let answer: number | null = null;
  /** アンカーを抱えている入れ物。scanCandidates の scope と同じ規則で決める */
  let scope: { matchesBefore: number } | null = null;

  await new HTMLRewriter()
    // 入れ物の開閉を先に追う。一致がどの入れ物に属するかを数えるのに要る
    .on(CANDIDATE_TAGS, {
      element(element) {
        const box = { matchesBefore: matchCount };
        elementScope(
          element,
          () => {
            openBoxes.push(box);
          },
          () => {
            const at = openBoxes.lastIndexOf(box);
            if (at !== -1) openBoxes.splice(at, 1);
          },
        );
      },
    })
    .on(selector, {
      element() {
        // アンカーを見た後で、まだ対象の入れ物が開いているなら、これがその記事のもの
        if (answer === null && scope !== null && openBoxes.includes(scope)) answer = matchCount;
        matchCount += 1;
      },
    })
    .on(anchorSelector(safe), {
      element() {
        if (answer !== null || scope !== null) return;

        const holder = openBoxes[openBoxes.length - 1];
        if (holder === undefined) return;
        scope = holder;
        // アンカーより前に、この入れ物の中で当たっていればそれを採る。
        // 記事の末尾にパーマリンクを置く作りがこれにあたる
        if (matchCount > holder.matchesBefore) answer = matchCount - 1;
      },
    })
    .transform(htmlResponse(html))
    .arrayBuffer();

  return answer;
}

/**
 * 記事 URL から `#` 以下を落としたページの URL。
 *
 * 日記型のサイトでは複数の記事が同じページを指すので、取りに行くときはここでまとめる。
 * フラグメントは HTTP では送られないので、落としても取得結果は変わらない。
 */
export function pageUrlOf(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
