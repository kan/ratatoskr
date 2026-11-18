import { formatTime } from '../../shared/time';
import type { AudioChapter, TranscriptSegment, TranscriptSummary } from '../../shared/types';
import { errorMessage } from '../lib/errors';
import { readAnswer, TEXT_MODEL } from './choose';
import { normalizeText } from './title';

/**
 * Podcast の文字起こしを要約する（issue #46）。
 *
 * **区間ごとに要約してから、全体の要旨を書かせる。** 2 時間半の文字起こしは 6〜8 万字で、
 * 1 回の問い合わせに載せられない。区間はチャプター（psc:chapters）があればそれを使い、
 * 無ければ 10 分ごとに切る。画面は区間の頭の時刻を再生位置へ飛ぶボタンにするので、要約が目次を兼ねる。
 *
 * **要約は日本語で書かせる。** 英語の番組でも要約は日本語で届く（翻訳の代わり）。
 * 文字起こしの全文は訳さない（長すぎて、要約に比べて読まれない）。
 *
 * **要約は HTML ではなく値で返す**（TranscriptSummary）。LLM の出力は平文として画面が
 * 文字で描くだけなので、v-html にもサニタイズにも通らない（CLAUDE.md の不変条件 4 の外に置く）。
 */

/** チャプターが無い番組の区間の長さ（秒） */
const SECTION_SECONDS = 600;

/**
 * 1 区間で LLM に見せる文字数の上限。超えた分は捨てる（要約の材料としては頭で足りる）。
 * llama-3.3-70b-instruct-fp8-fast の文脈長（24k トークン）に、指示と応答を足しても収まる幅
 */
const MAX_SECTION_CHARS = 12_000;

const SECTION_PROMPT = [
  'あなたは Podcast の文字起こしを要約します。',
  '与えられるのは番組の 1 区間の自動文字起こしで、誤認識を含みます。',
  'この区間で話されている話題を、日本語の 1〜3 文で要約してください。',
  '前置き・見出し・箇条書きは付けず、要約の文だけを返してください。',
].join('');

const OVERVIEW_PROMPT = [
  'あなたは Podcast の要約を書きます。',
  '与えられるのは番組の区間ごとの要約です。',
  'エピソード全体で何が話されたかを、日本語の 2〜4 文で要約してください。',
  '前置き・見出し・箇条書きは付けず、要約の文だけを返してください。',
].join('');

interface Section {
  start: number;
  /** チャプターの題。チャプターの無い番組では null */
  title: string | null;
  text: string;
}

/** 要約を作る。AI が使えなかった・何も返さなかったなら null */
export async function summarizeTranscript(
  segments: readonly TranscriptSegment[],
  episode: { title: string; audioUrl: string; chapters: readonly AudioChapter[] },
  ai: Ai,
): Promise<TranscriptSummary | null> {
  const sections = sectionsOf(segments, episode.chapters);
  if (sections.length === 0) return null;

  try {
    // 区間は互いに依存しないので並べて問い合わせる（待ちは CPU 時間に計上されない）
    const summaries = await Promise.all(
      sections.map((section) => ask(ai, SECTION_PROMPT, sectionInput(episode.title, section), 400)),
    );
    const digest = sections
      .map((section, i) => `[${formatTime(section.start)}] ${section.title ?? ''} ${summaries[i]}`)
      .join('\n');
    const overview = await ask(ai, OVERVIEW_PROMPT, `番組: ${episode.title}\n\n${digest}`, 600);
    if (overview === '') return null;

    return {
      overview,
      sections: sections.map((section, i) => ({
        start: section.start,
        title: section.title,
        text: summaries[i],
      })),
    };
  } catch (err) {
    console.warn('要約に失敗', episode.audioUrl, errorMessage(err));
    return null;
  }
}

/**
 * 区間に分ける。チャプターが 2 つ以上あればチャプターごと、無ければ 10 分ごと。
 * 何も話されていない区間（文字起こしが空）は落とす
 */
export function sectionsOf(
  segments: readonly TranscriptSegment[],
  chapters: readonly AudioChapter[],
): Section[] {
  if (segments.length === 0) return [];
  const last = segments[segments.length - 1].start;
  const bounds: { start: number; title: string | null }[] =
    chapters.length >= 2
      ? chapters.map((chapter, i) => ({ start: i === 0 ? 0 : chapter.start, title: chapter.title }))
      : Array.from({ length: Math.floor(last / SECTION_SECONDS) + 1 }, (_, i) => ({
          start: i * SECTION_SECONDS,
          title: null,
        }));

  // 区間も区間の中の文字起こしも時刻の順に並んでいるので、1 度なめるだけで振り分けられる
  let next = 0;
  return bounds.flatMap((bound, i) => {
    const end = bounds[i + 1]?.start ?? Infinity;
    const texts: string[] = [];
    while (next < segments.length && segments[next].start < end) {
      if (segments[next].start >= bound.start) texts.push(segments[next].text);
      next += 1;
    }
    const text = texts.join(' ').slice(0, MAX_SECTION_CHARS);
    return text.trim() === '' ? [] : [{ ...bound, text }];
  });
}

function sectionInput(episodeTitle: string, section: Section): string {
  const heading = section.title === null ? '' : `区間の題: ${section.title}\n`;
  return `番組: ${episodeTitle}\n${heading}\n${section.text}`;
}

/** 失敗は投げる（呼び出し側で null にまとめる） */
async function ask(ai: Ai, system: string, user: string, maxTokens: number): Promise<string> {
  const result = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0,
  });
  return normalizeText(readAnswer(result));
}
