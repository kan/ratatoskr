import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * サイドバーのスクロール位置（issue #5）。
 *
 * **最小限のスクロールにすると、読み進めるたびに現在地が下端に貼り付く。**
 * 次に何が来るかが見えず、フィードの終わりが近いことにも気付けない。
 */

/** カーソルの行と、スクロールする入れ物の余白（行数で数える） */
async function margin(page: Page): Promise<{ below: number; above: number; more: number }> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-active="true"]');
    const box = document.querySelector('[data-testid="feed-list"]');
    if (!(row instanceof HTMLElement) || !(box instanceof HTMLElement)) {
      throw new Error('カーソルの行が見つからない');
    }
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      below: (b.bottom - r.bottom) / r.height,
      above: (r.top - b.top) / r.height,
      // まだ下に隠れている分。0 なら末尾に着いていて、余白の検証にならない
      more: box.scrollHeight - box.scrollTop - box.clientHeight,
    };
  });
}

async function open(page: Page): Promise<void> {
  // 一覧が縦に収まってしまうとスクロールが起きず、何も確かめられない
  await mockApi(page, { extraEntries: 40 });
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
}

test('読み進めても、カーソルの行の下に次の記事が見えている', async ({ page }) => {
  await open(page);

  for (let i = 0; i < 30; i++) await page.keyboard.press('j');

  const { below, more } = await margin(page);
  expect(more).toBeGreaterThan(0);
  // 3 行ぶんの余白を空ける実装。1 行しか無ければ「下端に貼り付いている」に等しい
  expect(below).toBeGreaterThanOrEqual(2);
});

test('戻るときも、カーソルの行の上に余白を残す', async ({ page }) => {
  await open(page);

  for (let i = 0; i < 30; i++) await page.keyboard.press('j');
  for (let i = 0; i < 10; i++) await page.keyboard.press('k');

  const { above } = await margin(page);
  expect(above).toBeGreaterThanOrEqual(2);
});
