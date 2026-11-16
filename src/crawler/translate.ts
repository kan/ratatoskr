import { selectUntranslated, updateTranslations } from '../db/entries';
import { errorMessage } from '../lib/errors';
import { parseJson } from '../lib/json';
import { readAnswer, TEXT_MODEL } from './choose';
import { releaseBudget, reserveBudget, type FetchBudget } from './fetch';
import { elementScope, htmlResponse } from './rewriter';
import { escapeHtml, sanitizeHtml } from './sanitize';
import { normalizeText } from './title';

/**
 * 日本語以外の記事を日本語に訳す（issue #42）。
 *
 * **HTML を LLM に渡さない。** 本文のテキストの断片だけを番号付きの配列で渡し、同じ数の
 * 配列で返させて、元の位置に差し戻す。こうすると
 *
 * - コード（`pre` / `code`）・画像・リンクの URL は LLM の目に触れず、元のまま残る
 * - LLM がタグを壊したり、本文に無いものを書き足したりする余地が無い
 * - 訳文はテキストとしてエスケープして差し戻し、最後に必ずサニタイズを通す
 *   （CLAUDE.md の不変条件 4。LLM の出力は信頼できない入力として扱う）
 *
 * 断片はインラインの要素で切れる（`This is <a>a link</a>.` は 3 つ）。文の途中で切れた
 * 断片は訳が多少ぎこちなくなるが、構造を守る方を採る。配列のまま一度に渡すので、
 * 前後の断片は LLM から見えている。
 */

/** 1 回の問い合わせに載せるテキストの量（文字数）。超える本文は分けて訳す */
const CHUNK_CHARS = 3000;

/** 1 記事に使う問い合わせの上限。収まらない長さの記事は訳さない（too_long） */
const MAX_CHUNKS = 4;

/** 訳さない要素。中のテキストは断片として拾わない */
const KEEP_TAGS = 'pre, code, kbd, samp, var, script, style';

const SYSTEM_PROMPT = [
  'You translate text fragments of a web article into natural Japanese.',
  'You receive a JSON array of strings. Fragments are consecutive pieces of the same',
  'article, split at inline markup, so translate them in context.',
  'Return only a JSON array of strings with exactly the same length and order.',
  'Keep URLs, code, product names and numbers as they are. Do not add anything.',
].join(' ');

/**
 * 訳す必要があるか。かなが殆ど無ければ日本語ではないとみなす。
 *
 * 判定の目的は「日本語かどうか」だけなので、言語の判別まではしない（Workers に
 * langdetect は無い）。漢字だけを数えないのは中国語を日本語と取り違えないため
 */
export function needsTranslation(text: string): boolean {
  // 短すぎると判定が当てにならない。フィードに翻訳を勧めるかどうかの判定なので、
  // 迷うものは勧めない側に倒す
  if (letterCount(text) < 20) return false;
  return !isJapanese(text);
}

/**
 * 記事 1 本を訳さずに済ませてよいか（日本語か、訳す文字が無い）。
 *
 * **`needsTranslation` の文字数の下限を使わない。** あちらは勧めるかどうかの判定で、
 * 短いものを「訳さない」に倒している。記事ごとにそれを使うと、見出しと本文が短い
 * 外国語の記事（「v2.1 released」）に訳さない印が付き、二度と訳されない
 */
export function isJapanese(text: string): boolean {
  const letters = letterCount(text);
  if (letters === 0) return true;
  const kana = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return kana / letters >= 0.05;
}

function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

export interface Translation {
  title: string;
  /** サニタイズ済み HTML */
  body: string;
}

/**
 * 訳せなかった理由。**取り直してよいかで分ける。**
 *
 * - unavailable … Workers AI が使えなかった（障害・無料枠切れ）。時間を置けば訳せる
 * - unreadable … 応答の形が読めなかった。同じ記事は同じ応答になりやすく、取り直しても
 *   無料枠を使い続けるだけ
 * - too_long … 1 記事に使える問い合わせ（MAX_CHUNKS）に収まらない。頭だけ訳した記事は
 *   どこまでが訳なのか分からなくなるので、訳さない
 */
export type TranslationFailure = 'unavailable' | 'unreadable' | 'too_long';

/**
 * 記事を訳す。
 *
 * @param baseUrl サニタイズで相対 URL を解く基準（記事の URL）
 */
export async function translateEntry(
  title: string,
  bodyHtml: string,
  baseUrl: string | null,
  ai: Ai,
  /** 本文の断片。言語の判定で既に拾ってあれば渡す（本文を走査し直さない） */
  fragments?: readonly string[],
): Promise<Translation | TranslationFailure> {
  const sources = [title, ...(fragments ?? (await collectFragments(bodyHtml)))];
  // 文字数で見て収まらないものは問い合わせる前に断る（断片は割らないので、1 つの断片が
  // 長すぎると塊の数だけでは見抜けない）。断片の切れ目で塊を分けるので、文字数では
  // 収まっても塊の数が増えることもある
  if (sources.join('').length > CHUNK_CHARS * MAX_CHUNKS) return 'too_long';
  const chunks = chunksOf(sources);
  if (chunks.length > MAX_CHUNKS) return 'too_long';

  // 塊は互いに依存しないので並べて問い合わせる（待ちは CPU 時間に計上されない）
  const results = await Promise.all(chunks.map((chunk) => translateBatch(chunk, ai)));
  // 1 塊でも訳せなければ訳さない扱いにする。頭だけ訳した記事より、全部原文の方が
  // 読み手が戸惑わない（どこまでが訳なのか分からなくなる）。取り直してよい失敗を優先して返す
  const failures = results.filter((result) => typeof result === 'string');
  if (failures.length > 0) return failures.includes('unavailable') ? 'unavailable' : 'unreadable';

  const [translatedTitle, ...translatedFragments] = results.flat();
  return {
    title: translatedTitle,
    body: await sanitizeHtml(await replaceFragments(bodyHtml, translatedFragments), baseUrl),
  };
}

/** 断片を CHUNK_CHARS ごとの塊に分ける。断片は割らない（1 つで超えるものはそれだけで 1 塊） */
function chunksOf(sources: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const source of sources) {
    if (current.length > 0 && size + source.length > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(source);
    size += source.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function translateBatch(
  sources: string[],
  ai: Ai,
): Promise<string[] | 'unavailable' | 'unreadable'> {
  let answer: string;
  try {
    const result = await ai.run(TEXT_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(sources) },
      ],
      // 日本語は元の英語よりトークンを食う。足りないと配列が途中で切れて読めなくなる
      max_tokens: Math.min(4096, Math.ceil(sources.join('').length * 1.5) + 256),
      temperature: 0,
    });
    answer = readAnswer(result);
  } catch (err) {
    console.warn('翻訳に失敗', errorMessage(err));
    return 'unavailable';
  }
  return parseTranslations(answer, sources.length) ?? 'unreadable';
}

/**
 * 応答から訳文の配列を読む。前後に説明が付いて返ることがあるので、最初の `[` から
 * 最後の `]` までを JSON として読む。数が合わなければ null（どれがどれか分からない）
 */
export function parseTranslations(answer: string, count: number): string[] | null {
  const from = answer.indexOf('[');
  const to = answer.lastIndexOf(']');
  if (from < 0 || to <= from) return null;
  const parsed = parseJson(answer.slice(from, to + 1));
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  if (!parsed.every((item) => typeof item === 'string')) return null;
  return parsed as string[];
}

/**
 * 本文のテキストの断片を、出てくる順に拾う。空白だけの断片と、訳さない要素の中は飛ばす。
 *
 * **差し戻し（replaceFragments）と同じ規則で数える。** 同じ HTML を同じ規則で 2 度
 * 走査するので、n 番目の断片は両方で同じものを指す
 */
async function collectFragments(html: string): Promise<string[]> {
  const fragments: string[] = [];
  await walkText(html, (raw) => {
    // 空白を畳んだものを LLM に渡す
    const text = normalizeText(raw);
    if (text !== '') fragments.push(text);
    return null;
  });
  return fragments;
}

async function replaceFragments(html: string, translated: readonly string[]): Promise<string> {
  let index = 0;
  return walkText(html, (raw) => {
    if (normalizeText(raw) === '') return null;
    const text = translated[index];
    index += 1;
    // 前後の空白は残す。インラインの要素の境目の空白が消えると、語がくっつく
    const lead = /^\s*/.exec(raw)?.[0] ?? '';
    const trail = /\s*$/.exec(raw)?.[0] ?? '';
    return `${lead === '' ? '' : ' '}${escapeHtml(text)}${trail === '' ? '' : ' '}`;
  });
}

/**
 * テキストノードを 1 つずつ渡し、戻り値があればそれで置き換える。
 *
 * HTMLRewriter はテキストノードを細切れ（chunk）で渡し、渡し終えた chunk には後から
 * 手を出せない。そこで **chunk は渡されたその場で全て消し**、ノードの終わり
 * （lastInTextNode）で、溜めた分（置き換えなければ元のソースのまま）を最後の chunk に
 * 差し込む。元のソースは実体参照を含んだ HTML なので、そのまま HTML として戻せる
 */
async function walkText(html: string, visit: (raw: string) => string | null): Promise<string> {
  let kept = 0;
  let buffer = '';
  const rewriter = new HTMLRewriter()
    .on(KEEP_TAGS, {
      element(element) {
        elementScope(
          element,
          () => (kept += 1),
          () => (kept -= 1),
        );
      },
    })
    .onDocument({
      text(chunk) {
        if (kept > 0) return;
        buffer += chunk.text;
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        const replacement = visit(buffer) ?? buffer;
        chunk.replace(replacement, { html: true });
        buffer = '';
      },
    });
  return rewriter.transform(htmlResponse(html)).text();
}

/** 1 フィードにつき 1 回のクロールで訳す記事数 */
const MAX_PER_FEED = 5;

export interface TranslateOptions {
  ai: Ai | undefined;
  /** cron 1 回で訳せる記事数。フィードをまたいで減っていく（Workers AI の無料枠のため） */
  budget: FetchBudget;
}

/**
 * 訳すことにしたフィードの、まだ訳していない未読を訳す（取り込みの後、同じクロールの中で）。
 *
 * **新着は入れたその回に訳す。** 全文取得と同じく、読む時点では訳文が手元にある形に
 * したい。上限で溢れた分は原文のまま先に届き、次の回に訳して差分同期で差し替える
 * （body_updated_at。docs/DESIGN.md「翻訳」）。
 *
 * @returns 訳文を書き込んだ記事の id
 */
export async function translatePending(
  db: D1Database,
  feed: { id: number; translate: boolean },
  options: TranslateOptions,
): Promise<number[]> {
  if (!feed.translate || options.ai === undefined) return [];
  const limit = reserveBudget(options.budget, MAX_PER_FEED);
  if (limit === 0) return [];

  const targets = await selectUntranslated(db, feed.id, limit);
  releaseBudget(options.budget, limit - targets.length);

  const ai = options.ai;
  // 記事は互いに依存しないので並べて訳す（1 フィード 5 件まで。待ちは CPU 時間に計上されない）
  const outcomes = await Promise.all(
    targets.map(async (target) => {
      const fragments = await collectFragments(target.body);
      // 日本語の記事は訳さない印を付ける。訳すフィードにも日本語の記事は混ざる
      if (isJapanese(`${target.title}\n${fragments.slice(0, 50).join(' ')}`)) {
        return { id: target.id, title: '', body: '' };
      }
      const translated = await translateEntry(target.title, target.body, target.url, ai, fragments);
      // **AI が使えないときは印を付けない。** 付けると、障害や無料枠切れの間に回ってきた
      // 記事が二度と訳されない
      if (translated === 'unavailable') return null;
      // 読めない応答・長すぎる記事には印を付けて取り直しを止める（同じ記事は同じ結果に
      // なりやすく、付けないと毎回この記事で枠を使い切る）
      return typeof translated === 'string'
        ? { id: target.id, title: '', body: '' }
        : { id: target.id, title: translated.title, body: translated.body };
    }),
  );
  const rows = outcomes.filter((row) => row !== null);
  await updateTranslations(db, rows);
  return rows.filter((row) => row.body !== '').map((row) => row.id);
}
