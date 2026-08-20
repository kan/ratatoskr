import { expect, test, type Page } from '@playwright/test';
import { IMAGE_CACHE, mockApi } from './fixtures';

/**
 * 画像の先読み（M7 / docs/DESIGN.md §6）。
 *
 * 見るのは「読む前に取りに行っていること」と「ウィンドウから外れたら捨てること」。
 * ウィンドウの並びそのものは Vitest（stores/feeds.test.ts）で見ている。
 *
 * **HTTP キャッシュが効いていることはここでは確かめられない。** page.route で
 * 傍受するとブラウザの HTTP キャッシュが無効化される（同じ URL を 2 回 fetch すると
 * route が 2 回呼ばれることを実測で確認済み）。傍受の無い実ブラウザでは、先読み後の
 * 2 回目が転送を伴わずに返ることを確認してある。
 */

/** Cache API に載っているか。Service Worker（M8）はまだ無いので直接引く */
async function cached(page: Page, url: string): Promise<boolean> {
  return await page.evaluate(
    async ([cacheName, target]) => {
      const cache = await caches.open(cacheName);
      return (await cache.match(target)) !== undefined;
    },
    [IMAGE_CACHE, url],
  );
}

test('まだ表示していない記事と次のフィードの画像を先に取りに行く', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  // 12 は同じフィードの次の記事、21 は次のフィードの 1 本目。どちらもまだ表示していない
  await expect
    .poll(() => api.images)
    .toEqual(
      expect.arrayContaining(['https://img.example.com/12.jpg', 'https://img.example.com/21.jpg']),
    );

  // Service Worker（M8）がオフラインで返せるよう、Cache API にも載せておく
  await expect.poll(() => cached(page, 'https://img.example.com/21.jpg')).toBe(true);
});

test('ウィンドウから外れた画像を Cache API から捨てる', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  await expect.poll(() => cached(page, 'https://img.example.com/12.jpg')).toBe(true);

  // 朝刊を読み終えて夕刊へ。12 はもうウィンドウの後ろに落ちる
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目');

  await expect.poll(() => cached(page, 'https://img.example.com/12.jpg')).toBe(false);
});
