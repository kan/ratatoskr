import type { Candidate } from './extract';

/**
 * 記事ページのどこが本文かを決める（M7 の全文取得）。
 *
 * **判定はフィードにつき 1 回だけ。** 決まったセレクタは feeds.full_text_selector に
 * 残し、以降の記事は AI を呼ばずにそのセレクタで引く。同じサイトの記事ページは
 * 同じ型で作られているので、記事ごとに聞き直しても答えは変わらず、cron の実行時間と
 * Workers AI の無料枠を食うだけになる。
 *
 * AI に渡すのは候補の一覧（数百トークン）で、HTML そのものではない。記事ページは
 * 80KB を超えるのでコンテキストに乗らないし、乗ったとしても払う意味がない。
 *
 * AI が使えないとき・答えが読めないときは点数の 1 位に落とす。実際、テクノエッジの
 * 記事ページは点数だけで正解する（src/crawler/extract.test.ts）。AI はそれが効かない
 * サイトのための保険であって、無いと動かないものではない。
 */

/** 選ぶだけの仕事なので、速くて安いモデルで足りる */
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** AI に見せる候補の数。増やしても選びやすくはならず、外れを混ぜる余地が増える */
const MAX_CANDIDATES = 8;

/** 番号だけを返させるので短くてよい。長く喋り出したら打ち切る */
const MAX_TOKENS = 8;

const SYSTEM_PROMPT = [
  'You identify which container element holds the main article body of a web page.',
  'You are given candidates measured from the page: character counts, how many of',
  'those characters are inside links, a heuristic score, and the opening text.',
  'The main body is prose written for this one article. It is not navigation,',
  'related-article lists, comment sections, advertising blocks, or a wrapper that',
  'holds the whole page.',
  'Answer with the number of the best candidate and nothing else.',
].join(' ');

export type SelectorSource = 'ai' | 'score';

export interface BodySelector {
  selector: string;
  /** どちらが決めたか。後から「AI が外した」ことを追えるように残す */
  source: SelectorSource;
}

export async function chooseBodySelector(
  candidates: Candidate[],
  ai: Ai | undefined,
): Promise<BodySelector | null> {
  if (candidates.length === 0) return null;

  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  const byScore: BodySelector = { selector: shortlist[0].selector, source: 'score' };
  // 候補が 1 つしかないなら聞くまでもない
  if (ai === undefined || shortlist.length === 1) return byScore;

  let answer: string;
  try {
    const result = await ai.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: describeCandidates(shortlist) },
      ],
      max_tokens: MAX_TOKENS,
      // 同じページに同じ答えを返してほしい。創作の余地は要らない
      temperature: 0,
    });
    answer = readAnswer(result);
  } catch {
    // Workers AI が使えない（未契約・無料枠切れ・障害）。点数で決めて先へ進む
    return byScore;
  }

  const index = parseChoice(answer, shortlist.length);
  return index === null ? byScore : { selector: shortlist[index].selector, source: 'ai' };
}

function describeCandidates(candidates: Candidate[]): string {
  const lines = candidates.map((candidate, index) => {
    const linkRatio = Math.round((candidate.link / candidate.text) * 100);
    return [
      `${index + 1}. ${candidate.selector}`,
      `   chars=${candidate.text} link=${linkRatio}% score=${candidate.score}`,
      `   text: ${candidate.preview}`,
    ].join('\n');
  });
  return `${lines.join('\n')}\n\nWhich number is the main article body?`;
}

/**
 * Workers AI の応答から本文を取り出す。
 *
 * **形が 2 通りある。** 従来の `{ response: "..." }` と、OpenAI 互換の
 * `{ choices: [{ message: { content: "..." } }] }`。同じモデル名でも後者で返ることが
 * あり（llama-3.3-70b-instruct-fp8-fast は実測で後者だった）、前者しか見ていないと
 * 黙って空文字になって、AI を呼んだのに毎回点数へ落ちる。
 */
function readAnswer(result: unknown): string {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null) return '';

  const response = (result as { response?: unknown }).response;
  if (typeof response === 'string' && response !== '') return response;

  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * 応答から番号を読む。番号だけを返せと言ってあるが、`2` とも `2.` とも
 * `The answer is 2` とも返ってくるので、最初に出てくる数字を採る。
 * 範囲外なら null にして点数の 1 位に落とす。
 */
function parseChoice(answer: string, count: number): number | null {
  const match = /\d+/.exec(answer);
  if (match === null) return null;

  const choice = Number(match[0]);
  if (!Number.isInteger(choice) || choice < 1 || choice > count) return null;
  return choice - 1;
}
