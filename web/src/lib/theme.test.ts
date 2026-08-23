import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_KEY } from './prefs';
import { resolveTheme, THEME_COLOR, type Theme } from './theme';

/**
 * index.html の「最初の描画より前にテーマを当てる」スクリプトは、モジュールを
 * import できない位置にあるので、キー名・地色・解決規則を lib 側と二重に持っている。
 *
 * **食い違っても画面は動く。** 起動の一瞬だけ逆のテーマが出るか、保存した選択が
 * 読めずシステムに戻るだけなので、気付けるのはここだけ。
 *
 * 文字列の一致では見ずに**実際に走らせて突き合わせる**。綴りや整形を変えただけで
 * 落ちるテストは、直すべきものが無いのに赤くなり、しかも中身が間違っていても通る。
 */
const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf-8');

interface Applied {
  theme: string | undefined;
  colorScheme: string | undefined;
  themeColor: string | null;
}

/** インラインスクリプトを、偽のブラウザの上で走らせて結果を見る */
function runInlineScript(saved: string | null, systemDark: boolean): Applied {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error('index.html にインラインスクリプトが無い');

  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const meta = { content: null as string | null };
  const fakeDocument = {
    documentElement: root,
    querySelector: () => ({
      setAttribute: (_name: string, value: string) => {
        meta.content = value;
      },
    }),
  };
  const fakeWindow = {
    // **キー名の突き合わせもここで効く。** 別のキーを読んでいれば null が返り、
    // 保存済みの選択が反映されずに下の期待値とずれる
    localStorage: { getItem: (key: string) => (key === THEME_KEY ? saved : null) },
    matchMedia: (query: string) => ({ matches: query.includes('dark') ? systemDark : false }),
  };
  new Function('window', 'localStorage', 'document', script)(
    fakeWindow,
    fakeWindow.localStorage,
    fakeDocument,
  );
  return {
    theme: root.dataset.theme,
    colorScheme: root.style.colorScheme,
    themeColor: meta.content,
  };
}

describe('index.html のテーマ適用スクリプト', () => {
  const CASES: { choice: Theme | null; systemDark: boolean }[] = [
    { choice: null, systemDark: false },
    { choice: null, systemDark: true },
    { choice: 'light', systemDark: false },
    { choice: 'light', systemDark: true },
    { choice: 'dark', systemDark: false },
    { choice: 'dark', systemDark: true },
  ];

  it.each(CASES)('選択が $choice でシステムが dark=$systemDark のとき lib と一致する', (c) => {
    const applied = runInlineScript(c.choice, c.systemDark);
    const expected = resolveTheme(c.choice, c.systemDark);

    expect(applied.theme).toBe(expected);
    // ブラウザ既定の部品（select のリスト等）を揃えるため、こちらも当てる
    expect(applied.colorScheme).toBe(expected);
    expect(applied.themeColor).toBe(THEME_COLOR[expected]);
  });

  it('保存された値が壊れていればシステム設定に従う', () => {
    // 手で書き換えられた場合。lib 側も light / dark 以外は「未選択」に落とす
    expect(runInlineScript('まっくら', true).theme).toBe('dark');
    expect(runInlineScript('まっくら', false).theme).toBe('light');
  });
});
