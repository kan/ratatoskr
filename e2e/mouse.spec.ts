import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * PC でキーを使わない位置移動（issue #6）。
 *
 * バーの押下は j / k と同じ経路を通す。キーとの食い違いが生まれないこと、
 * 境界でフィードを跨ぐ振る舞いが同じであることが要点（docs/UX.md）。
 */

const title = (page: Page) => page.getByTestId('entry-title');

async function open(page: Page): Promise<void> {
  await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
}

test('PC でも記事送りのバーを出す', async ({ page }) => {
  await open(page);

  await expect(page.getByTestId('bottom-bar')).toBeVisible();
  await page.getByTestId('bottom-next').click();
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  await page.getByTestId('bottom-prev').click();
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('バーは境界でフィードを跨ぐ（キーと同じ経路）', async ({ page }) => {
  // 文言の規則そのものは e2e/mobile.spec.ts が 4 つの境界で見ている。
  // ここで確かめるのは、PC でも同じ経路を通ってフィードを跨ぐこと
  await open(page);
  await page.keyboard.press('j');

  await expect(page.getByTestId('bottom-next')).toContainText('次のフィード');
  await page.getByTestId('bottom-next').click();
  await expect(title(page)).toHaveText('夕刊の 1 本目');
});

test('バーを押した後の Enter で、記事がもう 1 本進まない', async ({ page }) => {
  await open(page);

  await page.getByTestId('bottom-next').click();
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  // フォーカスが残っていると Enter がボタンの再発火になる。
  // 進んだ分はウォーターマークで既読になり、未読には戻らない
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await expect(title(page)).toHaveText('朝刊の 2 本目');
});
