import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { IMAGE_CACHE, PREFETCH_IMAGE_CACHE } from '../web/src/lib/sw-policy';
import { HELP_SEEN_KEY } from '../web/src/lib/prefs';

/**
 * Service Worker（M8）。**組み上げた dist に対してだけ動く**ので、開発サーバを見ている
 * 他の spec とは別のプロジェクトで走らせる（playwright.config.ts の pwa）。
 *
 * ここで見るのは 3 つ。オフラインでも起動できること、読み終えた記事の画像が残ること、
 * リンクから開く API がアプリシェルを乗っ取らないこと。いずれも開発サーバでは
 * 再現しようがなく、壊れても他のテストは緑のままになる。
 */

const IMAGE = 'https://img.example.com/pwa.gif';
/** 1x1 の GIF */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Service Worker が出す要求も握るため、page ではなく context に route を張る
 * （page.route は Service Worker からの要求には当たらない）。
 */
async function mock(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => localStorage.setItem(key, '1'), HELP_SEEN_KEY);
  await context.route('**/api/bootstrap*', (route) =>
    route.fulfill({
      json: {
        serverTime: 1786000100,
        schemaVersion: 3,
        feeds: [],
        entries: [],
        pins: [],
        maxEntryId: 0,
      },
    }),
  );
  await context.route('**/api/entries*', (route) =>
    route.fulfill({ json: { entries: [], nextSinceId: null, hasMore: false } }),
  );
  await context.route('**/api/opml', (route) =>
    route.fulfill({ contentType: 'text/x-opml', body: '<opml version="2.0"></opml>' }),
  );
  // **HTTP キャッシュには残させない。** 残ると、Cache API に控えが無くても
  // オフラインで画像が出てしまい、控えているかどうかを見分けられない
  await context.route(IMAGE, (route) =>
    route.fulfill({
      contentType: 'image/gif',
      headers: { 'cache-control': 'no-store' },
      body: GIF,
    }),
  );
}

/** Service Worker が要求を握るまで待つ。初回の訪問では登録の後に一度読み直す */
async function install(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 30_000,
  });
  await page.reload();
}

/** 画像を読み込んで、出せたかを返す */
function loads(page: Page, url: string): Promise<boolean> {
  return page.evaluate(
    (src) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0);
        img.onerror = () => resolve(false);
        img.src = src;
      }),
    url,
  );
}

test('オフラインでも起動する', async ({ page, context }) => {
  await mock(context);
  await install(page);

  await context.setOffline(true);
  await page.reload();

  // アプリシェルと資産が控えられていないと、ここで白い画面になる
  await expect(page.getByTestId('open-manager')).toBeVisible();
  await expect(page.getByTestId('empty')).toBeVisible();
});

test('読み終えて先読みの窓から外れた画像も、オフラインで出せる', async ({ page, context }) => {
  await mock(context);
  await install(page);

  // 先読みが温めた状態を作る（lib/prefetch.ts と同じ置き方）
  await page.evaluate(
    async ([cacheName, url]) => {
      const cache = await caches.open(cacheName);
      await cache.put(url, await fetch(url, { mode: 'no-cors', credentials: 'omit' }));
    },
    [PREFETCH_IMAGE_CACHE, IMAGE] as const,
  );

  // 記事を読む = 画像が表示される。ここで Service Worker 側にも控えが要る
  expect(await loads(page, IMAGE)).toBe(true);

  // 読み終えた記事の画像はウィンドウから外れ、先読みが捨てる
  await page.evaluate(
    async ([cacheName, url]) => {
      const cache = await caches.open(cacheName);
      await cache.delete(url);
    },
    [PREFETCH_IMAGE_CACHE, IMAGE] as const,
  );
  expect(
    await page.evaluate(
      async ([cacheName, url]) => (await caches.match(url, { cacheName })) !== undefined,
      [IMAGE_CACHE, IMAGE] as const,
    ),
  ).toBe(true);

  await context.setOffline(true);
  // k で戻った先の画像が出る（控えが無ければ出ない）
  expect(await loads(page, IMAGE)).toBe(true);
});

test('リンクから開く API はアプリシェルを乗っ取らない', async ({ page, context }) => {
  await mock(context);
  await install(page);

  // OPML の書き出しはナビゲーション要求で届く。控えられると、次のオフライン起動で
  // 画面の代わりに OPML が出る
  await page.goto('/api/opml');
  await expect(page.locator('body')).toContainText('opml');

  await context.setOffline(true);
  await page.goto('/');
  await expect(page.getByTestId('open-manager')).toBeVisible();
});
