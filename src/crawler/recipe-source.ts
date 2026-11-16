import type { RecipeSource } from '../../shared/types';
import { inferRecipe } from './infer';
import { runRecipe, type Recipe } from './recipe';
import type { Source } from './types';

/**
 * 取得定義で読む取り込み口（issue #40）。
 *
 * **HTML のページを取りに行く定義は robots.txt に従う。** 一覧のページは購読した
 * フィードではなく、こちらが選んで読みに行くページなので、全文取得の記事ページと
 * 同じ扱いにする（issue #39）。裏の API（json）は購読者が決めた取得先なので、
 * フィード本体と同じく見ない。
 *
 * **推定した定義（ai / score）は、記事が取れなくなったら作り直す。** サイトの
 * 作り替えで一覧の構造が変わると、定義は黙って 0 件を返し始める。一覧のページは
 * 取れているので、それを材料に推定し直し、取れたら覚え直す。手で書いた定義
 * （manual）は推定で作れないから手で書いてあるので、失敗として記録して人に知らせる
 */
export function recipeSource(recipe: Recipe, source: RecipeSource | null): Source {
  return {
    fetch(target, fetchImpl, now, context) {
      const html = recipe.list.format !== 'json';
      return runRecipe(recipe, target, html ? (context?.fetchPage ?? fetchImpl) : fetchImpl, now, {
        reinfer:
          html && source !== 'manual'
            ? async (body, listUrl) => {
                const inferred = await inferRecipe(
                  body,
                  listUrl,
                  recipe.title ?? '',
                  context?.ai,
                  now,
                );
                if (inferred === null) return null;
                await context?.saveRecipe?.(JSON.stringify(inferred.recipe), inferred.source);
                return inferred.feed;
              }
            : undefined,
      });
    },
  };
}
