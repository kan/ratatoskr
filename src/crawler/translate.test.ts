import { describe, expect, it } from 'vitest';
import {
  needsTranslation,
  parseTranslations,
  translateEntry,
  type Translation,
  type TranslationFailure,
} from './translate';

/** 訳せたことを確かめてから中身を見る */
function translated(result: Translation | TranslationFailure): Translation {
  if (typeof result === 'string') throw new Error(`訳せていない: ${result}`);
  return result;
}

/**
 * 翻訳（issue #42）。Workers AI は差し替える。見るのは「構造を壊さない」
 * 「LLM の出力をそのまま HTML にしない」「読めない応答で半端に訳さない」。
 */

/** 受け取った配列の各要素に印を付けて返す AI。何を渡されたかも残す */
function stubAi(transform: (texts: string[]) => unknown = (texts) => texts.map((t) => `訳:${t}`)) {
  const seen: string[][] = [];
  const ai = {
    run: (_model: string, input: { messages: { role: string; content: string }[] }) => {
      const texts = JSON.parse(input.messages[1].content) as string[];
      seen.push(texts);
      return Promise.resolve({ response: JSON.stringify(transform(texts)) });
    },
  } as unknown as Ai;
  return { ai, seen };
}

describe('needsTranslation', () => {
  it('かなの無い文章は訳す。日本語と短すぎるものは訳さない', () => {
    expect(needsTranslation('This is an English article about squirrels and trees.')).toBe(true);
    expect(needsTranslation('这是一篇关于松鼠和树木的中文文章，内容很长很长。')).toBe(true);
    expect(needsTranslation('これは日本語の記事です。Cloudflare Workers の話をします。')).toBe(
      false,
    );
    expect(needsTranslation('Short.')).toBe(false);
  });
});

describe('translateEntry', () => {
  it('テキストだけを訳し、コード・画像・リンクの URL はそのまま残す', async () => {
    const { ai, seen } = stubAi();
    const html =
      '<p>Read <a href="https://example.com/a">the docs</a> first.</p>' +
      '<pre><code>const x = 1;</code></pre><p><img src="https://example.com/i.png" alt="x"></p>';

    const result = translated(await translateEntry('Hello', html, 'https://example.com/', ai));

    expect(seen[0]).toEqual(['Hello', 'Read', 'the docs', 'first.']);
    expect(result.title).toBe('訳:Hello');
    expect(result.body).toMatch(/<a href="https:\/\/example.com\/a"[^>]*>訳:the docs<\/a>/);
    expect(result.body).toContain('<code>const x = 1;</code>');
    expect(result.body).toContain('<img src="https://example.com/i.png"');
  });

  it('LLM が返したタグは文字として入る（不変条件 4）', async () => {
    const { ai } = stubAi((texts) => texts.map(() => '<script>alert(1)</script><b>x</b>'));
    const result = translated(await translateEntry('Title', '<p>Body text</p>', null, ai));
    expect(result.body).not.toContain('<script');
    expect(result.body).not.toContain('<b>');
    expect(result.body).toContain('&lt;script&gt;');
  });

  it('数の合わない応答なら訳さない', async () => {
    const { ai } = stubAi((texts) => texts.slice(1));
    expect(await translateEntry('Title', '<p>Body text</p>', null, ai)).toBe('unreadable');
  });

  it('AI が使えないときは、読めない応答と分けて返す（取り直してよい）', async () => {
    const ai = { run: () => Promise.reject(new Error('quota')) } as unknown as Ai;
    expect(await translateEntry('Title', '<p>Body text</p>', null, ai)).toBe('unavailable');
  });

  it('1 記事の問い合わせに収まらない長さは、頭だけ訳さずに訳さない', async () => {
    const { ai, seen } = stubAi();
    const long = '<p>' + 'A long sentence about squirrels. '.repeat(500) + '</p>';
    expect(await translateEntry('Title', long, null, ai)).toBe('too_long');
    expect(seen).toHaveLength(0);
  });

  it('実体参照を含む元の文は、訳さなかった断片でも壊さない', async () => {
    const { ai } = stubAi((texts) => texts.map((t, i) => (i === 0 ? '題' : t)));
    const result = translated(await translateEntry('T', '<p>A &amp; B</p>', null, ai));
    expect(result.body).toBe('<p>A &amp; B</p>');
  });
});

describe('parseTranslations', () => {
  it('前後に説明が付いていても配列を読む', () => {
    expect(parseTranslations('Here you go: ["a","b"] done', 2)).toEqual(['a', 'b']);
    expect(parseTranslations('["a"]', 2)).toBeNull();
    expect(parseTranslations('not json', 1)).toBeNull();
  });
});
