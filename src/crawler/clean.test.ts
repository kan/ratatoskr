import { describe, expect, it } from 'vitest';
import { CLEAN_MODEL, cleanPart, glossaryOf, parseParagraphs } from './clean';

/**
 * 文字起こしの清書（issue #46）。見るのは「段落の時刻を LLM に作らせない」
 * 「崩れた応答・要約にすり替わった応答を使わない」「ショーノートを用語集にする」。
 */

const SEGMENTS = [
  { start: 0, text: 'あの' },
  { start: 1.5, text: 'レイルズの話なんですけど' },
  { start: 4, text: 'うん' },
  { start: 6.2, text: 'ラストで書き直したって' },
];

describe('parseParagraphs', () => {
  it('段落の時刻は最初の区間から取る', () => {
    const answer = JSON.stringify([
      { from: 0, text: 'Rails の話なんですけど。' },
      { from: 3, text: 'Rust で書き直したって。' },
    ]);
    expect(parseParagraphs(answer, SEGMENTS)).toEqual([
      { start: 0, text: 'Rails の話なんですけど。' },
      { start: 6.2, text: 'Rust で書き直したって。' },
    ]);
  });

  it('前後の説明は読み飛ばし、段落の中の改行は空白に畳む', () => {
    const answer = `清書しました。\n${JSON.stringify([{ from: 0, text: 'Rails の\n話と、Rust で書き直した話。' }])}\n以上です。`;
    expect(parseParagraphs(answer, SEGMENTS)).toEqual([
      { start: 0, text: 'Rails の 話と、Rust で書き直した話。' },
    ]);
  });

  it.each([
    ['JSON でない', 'すみません'],
    ['空の配列', '[]'],
    ['0 から始まらない', JSON.stringify([{ from: 1, text: 'Rails の話なんですけど、Rust で。' }])],
    [
      '番号が増えていない',
      JSON.stringify([
        { from: 0, text: 'Rails の話なんですけど。' },
        { from: 0, text: 'Rust で書き直したって。' },
      ]),
    ],
    [
      '範囲外の番号',
      JSON.stringify([
        { from: 0, text: 'Rails の話。' },
        { from: 4, text: 'Rust。' },
      ]),
    ],
    ['番号が数でない', JSON.stringify([{ from: '0', text: 'Rails の話なんですけど、Rust で。' }])],
    [
      '文が空の段落',
      JSON.stringify([
        { from: 0, text: 'Rails の話なんですけど、Rust で。' },
        { from: 2, text: ' ' },
      ]),
    ],
    [
      '要約にすり替わった（元の 7 割に満たない）',
      JSON.stringify([{ from: 0, text: 'Rust の話。' }]),
    ],
    ['区切りの末尾を落とした', JSON.stringify([{ from: 0, text: 'Rails の話なんですけど。' }])],
  ])('%s なら使わない', (_, answer) => {
    expect(parseParagraphs(answer, SEGMENTS)).toBeNull();
  });
});

describe('cleanPart', () => {
  function stub(respond: () => Promise<unknown>) {
    const calls: { user: string }[] = [];
    const ai = {
      run: (model: string, input: { messages: { content: string }[] }) => {
        expect(model).toBe(CLEAN_MODEL);
        calls.push({ user: input.messages[1].content });
        return respond();
      },
    } as unknown as Ai;
    return { ai, calls };
  }

  it('区間の文を配列で渡し、ショーノートを参考情報に添える', async () => {
    const answer = JSON.stringify([
      { from: 0, text: 'Rails の話なんですけど、Rust で書き直したって。' },
    ]);
    const { ai, calls } = stub(() => Promise.resolve({ response: answer }));

    const result = await cleanPart(
      SEGMENTS,
      { title: '433: Jev', glossary: 'Rails World / Rust' },
      ai,
    );

    expect(result).toEqual([{ start: 0, text: 'Rails の話なんですけど、Rust で書き直したって。' }]);
    expect(calls[0].user).toContain('433: Jev');
    expect(calls[0].user).toContain('Rails World / Rust');
    // 断片の番号は行頭に明示する（LLM に配列の位置を数えさせない）
    expect(calls[0].user).toContain('0: あの\n1: レイルズの話なんですけど\n2: うん\n3: ラストで');
  });

  it('読み解き済みの JSON で返った応答も読む', async () => {
    const answer = [{ from: 0, text: 'Rails の話なんですけど、Rust で書き直したって。' }];
    const { ai } = stub(() => Promise.resolve({ response: answer }));
    expect(await cleanPart(SEGMENTS, { title: 't', glossary: '' }, ai)).toEqual([
      { start: 0, text: 'Rails の話なんですけど、Rust で書き直したって。' },
    ]);
  });

  it('AI が使えなければ unavailable、応答が使えなければ清書前の区間を返す', async () => {
    const episode = { title: 't', glossary: '' };
    expect(
      await cleanPart(SEGMENTS, episode, stub(() => Promise.reject(new Error('down'))).ai),
    ).toBe('unavailable');
    expect(
      await cleanPart(SEGMENTS, episode, stub(() => Promise.resolve({ response: 'だめ' })).ai),
    ).toEqual(SEGMENTS);
  });

  it('区間が無ければ AI を呼ばない', async () => {
    const { ai, calls } = stub(() => Promise.resolve({ response: '[]' }));
    expect(await cleanPart([], { title: 't', glossary: '' }, ai)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('glossaryOf', () => {
  it('本文のテキストを繋ぎ、長ければ切る', async () => {
    expect(await glossaryOf('<p>ゲスト</p><ul><li><a href="#">Rails World</a></li></ul>')).toBe(
      'ゲスト / Rails World',
    );
    expect((await glossaryOf(`<p>${'あ'.repeat(5000)}</p>`)).length).toBe(2000);
    expect(await glossaryOf(null)).toBe('');
  });
});
