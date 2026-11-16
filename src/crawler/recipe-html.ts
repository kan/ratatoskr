import type { RawItem, RecipeField } from './recipe';
import { applyTemplate } from './recipe';
import { elementScope, htmlResponse } from './rewriter';
import { normalizeText } from './title';

/**
 * 取得定義の html 形式（src/crawler/recipe.ts）。セレクタで記事の一覧を取り出す。
 *
 * Workers に DOMParser は無いので HTMLRewriter で読む。HTMLRewriter は木を作らず
 * 頭から流れていくだけなので、「この見出しはどの記事のものか」は、**いま開いている
 * 記事の要素**に割り当てて決める。記事の要素が入れ子にならない限りこれで足りる
 * （一覧の 1 件の中に別の 1 件が入ることはない）。
 *
 * 各値は記事の中で最初に当たったものを採る。サムネイルと見出しの両方がリンクに
 * なっている一覧では、リンクのセレクタが 2 回当たる。
 */

type Fields = Partial<Record<keyof RawItem, RecipeField>>;

/** 1 つの値に溜めるテキストの上限。要約に記事全文が入る形で暴れないように */
const MAX_TEXT = 4000;

export async function extractHtmlItems(
  html: string,
  itemSelector: string,
  fields: Fields,
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let current: RawItem | null = null;
  /** テキストを溜めている値。入れ子の要素の中の文字も、終了タグまでは同じ値に入る */
  const capturing = new Set<keyof RawItem>();
  const buffers = new Map<keyof RawItem, string>();

  let rewriter = new HTMLRewriter().on(itemSelector, {
    element(element) {
      elementScope(
        element,
        () => {
          current = {};
          capturing.clear();
          buffers.clear();
          // 記事の要素そのものから取る値（selector を省いたもの）
          for (const [name, field] of entries(fields)) {
            if (field.selector !== undefined) continue;
            if (field.attr !== undefined) {
              current[name] = applyTemplate(attribute(element, field.attr), field.template);
            } else {
              capturing.add(name);
              buffers.set(name, '');
            }
          }
        },
        () => {
          if (current === null) return;
          for (const [name, buffer] of buffers) {
            if (current[name] === undefined) {
              current[name] = applyTemplate(normalizeText(buffer), fields[name]?.template);
            }
          }
          items.push(current);
          current = null;
          capturing.clear();
          buffers.clear();
        },
      );
    },
  });

  for (const [name, field] of entries(fields)) {
    if (field.selector === undefined) continue;
    rewriter = rewriter.on(`${itemSelector} ${field.selector}`, {
      element(element) {
        const item = current;
        if (item === null || item[name] !== undefined || buffers.has(name)) return;
        if (field.attr !== undefined) {
          const value = attribute(element, field.attr);
          if (value !== null) item[name] = applyTemplate(value, field.template);
          return;
        }
        buffers.set(name, '');
        elementScope(
          element,
          () => capturing.add(name),
          () => {
            capturing.delete(name);
            const value = normalizeText(buffers.get(name) ?? '');
            buffers.delete(name);
            // **空なら次に当たる要素に譲る。** サムネイルと見出しの両方がリンクの一覧では、
            // 先に当たるのは文字の無い画像のリンクの方
            if (value !== '' && item[name] === undefined) {
              item[name] = applyTemplate(value, field.template);
            }
          },
        );
      },
    });
  }

  // テキストは要素の中の全ての文字を拾う。`*` のテキストハンドラは要素に包まれた
  // 文字にしか当たらないが、記事の要素の中は全て何かに包まれている
  let hidden = 0;
  rewriter = rewriter.on('*', {
    text(chunk) {
      if (current === null || capturing.size === 0 || hidden > 0) return;
      for (const name of capturing) {
        const buffer = buffers.get(name) ?? '';
        if (buffer.length < MAX_TEXT) buffers.set(name, buffer + chunk.text);
      }
    },
  });
  // script / style の中の文字は本文ではない
  rewriter = rewriter.on('script, style, noscript, template', {
    element(element) {
      elementScope(
        element,
        () => (hidden += 1),
        () => (hidden -= 1),
      );
    },
  });

  await rewriter.transform(htmlResponse(html)).text();
  return items;
}

/** 属性値は実体参照が解かれないまま来る（href の `&amp;`） */
function attribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null ? null : normalizeText(value);
}

function entries(fields: Fields): [keyof RawItem, RecipeField][] {
  return Object.entries(fields).filter(
    (e): e is [keyof RawItem, RecipeField] => e[1] !== undefined,
  );
}
