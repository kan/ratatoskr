import { describe, expect, it } from 'vitest';
import { chooseBodySelector } from './choose';
import type { Candidate } from './extract';

/**
 * 本文の位置を誰が決めるか（M7）。
 *
 * AI が決めるのはフィードにつき 1 回だけで、答えが読めないときは点数に落ちる。
 * 「AI が無いと動かない」形にしないことが要件（src/crawler/choose.ts）。
 */

function candidate(selector: string, score: number): Candidate {
  return {
    selector,
    text: score * 2,
    link: 0,
    score,
    preview: `${selector} の書き出し`,
    signature: `sig-${selector}`,
  };
}

/** 指定した文字列を返すだけの Workers AI。渡されたプロンプトも控える */
function stubAi(answer: string | (() => never)): { ai: Ai; prompts: string[] } {
  const prompts: string[] = [];
  const ai = {
    run(_model: string, inputs: { messages: { role: string; content: string }[] }) {
      prompts.push(inputs.messages.map((message) => message.content).join('\n'));
      if (typeof answer !== 'string') answer();
      return Promise.resolve({ response: answer });
    },
  } as unknown as Ai;
  return { ai, prompts };
}

/** OpenAI 互換の形で返す Workers AI。同じモデル名でもこちらで返ることがある */
function stubOpenAiShapedAi(answer: string): Ai {
  return {
    run: () => Promise.resolve({ choices: [{ message: { content: answer } }] }),
  } as unknown as Ai;
}

const CANDIDATES = [
  candidate('div.wrapper', 900),
  candidate('article.body', 800),
  candidate('aside.related', 100),
];

describe('chooseBodySelector', () => {
  it('AI が選んだ候補を採る', async () => {
    const { ai } = stubAi('2');

    expect(await chooseBodySelector(CANDIDATES, ai)).toEqual({
      selector: 'article.body',
      source: 'ai',
    });
  });

  it('番号だけでなく文章で返ってきても読み取る', async () => {
    const { ai } = stubAi('The main article body is 2.');

    expect(await chooseBodySelector(CANDIDATES, ai)).toMatchObject({ selector: 'article.body' });
  });

  it('AI に渡すのは候補の一覧だけ（HTML は渡さない）', async () => {
    const { ai, prompts } = stubAi('2');
    await chooseBodySelector(CANDIDATES, ai);

    expect(prompts[0]).toContain('article.body');
    expect(prompts[0]).toContain('aside.related の書き出し');
    // 記事ページは 80KB を超える。渡す余地は無いし、渡す意味も無い
    expect(prompts[0].length).toBeLessThan(2000);
  });

  it('OpenAI 互換の応答からも番号を読み取る', async () => {
    // 実測でこの形が返った。前者しか見ていないと黙って空文字になり、
    // AI を呼んでいるのに毎回点数へ落ちる
    expect(await chooseBodySelector(CANDIDATES, stubOpenAiShapedAi('2'))).toEqual({
      selector: 'article.body',
      source: 'ai',
    });
  });

  it('範囲外の番号なら点数の 1 位に落とす', async () => {
    const { ai } = stubAi('9');

    expect(await chooseBodySelector(CANDIDATES, ai)).toEqual({
      selector: 'div.wrapper',
      source: 'score',
    });
  });

  it('数字が返ってこなければ点数の 1 位に落とす', async () => {
    const { ai } = stubAi('I cannot determine the answer.');

    expect(await chooseBodySelector(CANDIDATES, ai)).toMatchObject({ source: 'score' });
  });

  it('Workers AI が使えなければ点数の 1 位に落とす', async () => {
    const { ai } = stubAi(() => {
      throw new Error('AI binding unavailable');
    });

    expect(await chooseBodySelector(CANDIDATES, ai)).toMatchObject({ source: 'score' });
  });

  it('AI の設定が無ければ点数だけで決める', async () => {
    expect(await chooseBodySelector(CANDIDATES, undefined)).toEqual({
      selector: 'div.wrapper',
      source: 'score',
    });
  });

  it('候補が 1 つなら聞かない', async () => {
    const { ai, prompts } = stubAi('1');
    const chosen = await chooseBodySelector([candidate('article.body', 800)], ai);

    expect(chosen).toMatchObject({ selector: 'article.body', source: 'score' });
    expect(prompts).toEqual([]);
  });

  it('候補が無ければ決めない', async () => {
    const { ai } = stubAi('1');
    expect(await chooseBodySelector([], ai)).toBeNull();
  });
});
