import type { TranscriptSegment } from '../../shared/types';
import { errorMessage } from '../lib/errors';
import { asObject } from '../lib/json';
import { readAnswer, readJsonArray } from './choose';
import { collectFragments } from './translate';

/**
 * Podcast の文字起こしを清書する（issue #46）。
 *
 * Whisper の文字起こしは発言の切れ目ごとの細切れ（「あの」「うん」も 1 区間）で、
 * 固有名詞はカタカナになる（Rails が「レイルズ」）。起こし終えた後に、区切り
 * （transcript_parts の 1 行。約 5 分半）ごとに LLM へ渡し、話のまとまりで段落にして
 * 句読点を補い、固有名詞を直させる。
 *
 * **固有名詞はショーノート（記事の本文）の綴りに合わせる。** Podcast のショーノートには
 * 話題に出たサービスや人の名前が正しい綴りで並んでいるので、用語集として渡す。
 *
 * **段落の時刻は LLM に書かせない。** 区間を番号付きの配列で渡し、段落ごとに「最初の区間の
 * 番号」を返させて、時刻はその区間から取る（LLM が時刻を作り出す余地を無くす）。番号が
 * 崩れていたり、文が元より極端に短い（要約や省略にすり替わった）応答は使わない。
 *
 * 清書は値（段落の配列）で返し、画面は文字として描くだけ（要約と同じく v-html を通さない）。
 */

/**
 * 清書のモデル。要約と翻訳の llama-3.3-70b ではない。
 *
 * Rebuild 433 回の同じ区切りで比べた（2026-11-18）。llama-3.3-70b は段落にはまとめるが、
 * ショーノートにある名前（Jev、Daring Fireball）すらカタカナのまま残した。qwen3.8-27b は
 * 直す語は多いが「ラスト」を LLM と取り違え、遅かった。deepseek-v4.1-flash が最も多く正しく
 * 直し（Rust、Akamai、DeepSeek）、最も速く、出力の単価も llama より安い
 */
export const CLEAN_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

/** 用語集として LLM に見せるショーノートの長さ（文字数） */
const MAX_GLOSSARY_CHARS = 2000;

/**
 * 清書が元の何割より短ければ、要約や省略にすり替わった（区切りの末尾を落とした）とみなすか。
 * 言い淀みを除いた分だけ短くなるのは正常。Rebuild 433 回の実測では元の 104%（句読点の分だけ増えた）
 */
const MIN_LENGTH_RATIO = 0.7;

const SYSTEM_PROMPT = [
  'あなたは Podcast の自動文字起こしを清書します。',
  '文字起こしは 1 行に 1 つ、発言の切れ目で区切られた断片で与えられます。',
  '各行の頭の「番号:」がその断片の番号です。誤認識を含みます。',
  '仕事は 2 つです。',
  '1 つ目は固有名詞の表記を直すことです。製品名・サービス名・企業名・プログラミング言語名・',
  'AI モデル名・Web サイト名など、英語の名前がカタカナや誤った字で書かれていたら、',
  '必ず英字の正式な表記に直してください（例: ギットハブ → GitHub、パイソン → Python、',
  'ジェミニ → Gemini、ブイエスコード → VS Code）。',
  '参考情報（ショーノート）に読みの近い名前があれば、必ずその綴りを使ってください。',
  '明らかな聞き間違いも文脈から直してください。',
  '2 つ目は、断片を話のまとまりごとに段落にまとめ、句読点を補って読みやすい文にすることです。',
  '話された言語のまま書き、翻訳はしないでください（英語の番組なら英語のまま）。',
  '「あの」「えー」などの言い淀みは除いてかまいません。発言を鉤括弧で囲まないでください。',
  '話された内容は要約・省略・追加をせず、すべて残してください。',
  'JSON の配列だけを返してください。各要素は {"from": 段落の最初の断片の番号, "text": "清書した段落"} です。',
  'from には、その段落の text が始まる断片の行頭の番号を正確に書いてください。',
  'from の小さい順に並べ、最初の段落の from は 0 にしてください。',
].join('');

/**
 * 区切り 1 つの区間を清書する。AI が使えなかった（障害・枠切れ）なら unavailable で、
 * 次の cron で取り直す。
 *
 * **応答が使えなかったら、清書前の区間をそのまま返す。** 取り直しても同じになりやすいので、
 * その区切りは清書前で終える（1 区切りのために要約まで止めない）
 */
export async function cleanPart(
  segments: TranscriptSegment[],
  episode: { title: string; glossary: string },
  ai: Ai,
): Promise<TranscriptSegment[] | 'unavailable'> {
  if (segments.length === 0) return [];
  const texts = segments.map((segment) => segment.text);
  const glossary =
    episode.glossary === '' ? '' : `参考情報（ショーノート）:\n${episode.glossary}\n\n`;

  let answer: string;
  let result: unknown;
  try {
    result = await ai.run(CLEAN_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          // 番号は行頭に明示する。配列の位置で指させると、LLM が数え違えて段落の時刻がずれる
          content: `番組: ${episode.title}\n${glossary}文字起こし:\n${texts.map((text, i) => `${i}: ${text}`).join('\n')}`,
        },
      ],
      // 句読点と JSON の分だけ元より長くなる。足りないと配列が途中で切れて読めなくなる
      max_tokens: Math.min(8192, Math.ceil(texts.join('').length * 1.5) + 512),
      // **思考を切る。** 推論型のモデルなので、切らないと思考が max_tokens を使い切って
      // 本文が空のまま返る（実測）。清書に思考は要らない
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
    });
    answer = readAnswer(result);
  } catch (err) {
    console.warn('清書に失敗', errorMessage(err));
    return 'unavailable';
  }
  const paragraphs = parseParagraphs(answer, segments);
  if (paragraphs !== null) return paragraphs;
  console.warn('清書の応答を読めない。清書前で代える', JSON.stringify(result).slice(0, 600));
  return segments;
}

/**
 * 応答から段落を読む。次のどれかなら null（使わない）
 *
 * - 段落の番号が 0 から始まっていない・増えていない・範囲外（どの区間の時刻か分からない）
 * - 文が空の段落がある
 * - 清書の文字数が元の 7 割に満たない（要約や省略にすり替わった・末尾を落とした）
 */
export function parseParagraphs(
  answer: string,
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] | null {
  const parsed = readJsonArray(answer);
  if (parsed === null || parsed.length === 0) return null;

  const paragraphs: TranscriptSegment[] = [];
  let previous = -1;
  for (const value of parsed) {
    const item = asObject(value);
    const index = item?.from;
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/gu, ' ').trim() : '';
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    if (index <= previous || index >= segments.length || text === '') return null;
    if (previous === -1 && index !== 0) return null;
    paragraphs.push({ start: segments[index].start, text });
    previous = index;
  }

  const before = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  const after = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  return after >= before * MIN_LENGTH_RATIO ? paragraphs : null;
}

/** 用語集にするショーノートのテキスト。本文の断片を繋いで、長ければ切る */
export async function glossaryOf(bodyHtml: string | null): Promise<string> {
  if (bodyHtml === null || bodyHtml === '') return '';
  const fragments = await collectFragments(bodyHtml);
  return fragments.join(' / ').slice(0, MAX_GLOSSARY_CHARS);
}

// 清書のモデルは wrangler types の型定義にまだ無い。入出力の形は同じ系列の
// deepseek-v4-flash と同じ（OpenAI 互換の chat completions）
declare global {
  interface AiModels {
    '@cf/deepseek-ai/deepseek-v4.1-flash-1017': Base_Ai_Cf_Deepseek_Ai_Deepseek_V4_Flash_0731;
  }
}
