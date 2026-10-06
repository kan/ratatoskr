import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * 外部ブックマークへ送る（issue #22）。
 *
 * URL の組み立ては Vitest（lib/bookmark.test.ts）で見ているので、ここでは
 * 押すと相手の投稿画面が開くこと、ピンから送るとピンが外れること、
 * 送り先を端末ごとに変えられることを確認する。
 */

const title = (page: Page) => page.getByTestId('entry-title');

/** 送信は outbox の debounce（2 秒）の後に走る */
const SEND_TIMEOUT = 15_000;

async function open(page: Page, context: BrowserContext) {
  // 相手の画面は開くだけで、中身は見ない。外へ取りに行かせない
  await context.route(/^https:\/\/(b\.hatena\.ne\.jp|bm\.example\.com)\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>投稿画面</title>' }),
  );
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目', { timeout: 15_000 });
  return recorder;
}

test('b で、読んでいる記事の投稿画面を新しいタブで開く', async ({ page, context }) => {
  await open(page, context);

  const opened = context.waitForEvent('page');
  await page.keyboard.press('b');
  const target = new URL((await opened).url());

  expect(target.origin + target.pathname).toBe('https://b.hatena.ne.jp/my/add.confirm');
  expect(target.searchParams.get('url')).toBe('https://example.com/1/entries/11');
  // 記事は切り替えない。ピンも立てない
  await expect(title(page)).toHaveText('朝刊の 1 本目');
  await expect(page.getByTestId('open-pins')).toHaveText('ピン');
});

test('ピン一覧から送ると、そのピンを外す', async ({ page, context }) => {
  const recorder = await open(page, context);
  await page.keyboard.press('p');
  await page.keyboard.press('j');
  await page.keyboard.press('p');
  // サーバが id を振るまで待つ（外すには id が要る）
  await expect.poll(() => recorder.pinned.length, { timeout: SEND_TIMEOUT }).toBe(2);

  await page.keyboard.press('z');
  const opened = context.waitForEvent('page');
  await page.getByTestId('pin-bookmark-11').click();
  const target = new URL((await opened).url());
  expect(target.searchParams.get('url')).toBe('https://example.com/1/entries/11');

  // 送った 1 件だけが外れ、一覧は開いたまま（続けて次を処理できる）
  const list = page.getByTestId('pin-list');
  await expect(list).toContainText('ピン（1）');
  await expect(list).not.toContainText('朝刊の 1 本目');
  await expect(list).toContainText('朝刊の 2 本目');
  await expect.poll(() => recorder.unpinned, { timeout: SEND_TIMEOUT }).toEqual([901]);
});

test('ブラウザにブロックされたら、ピンは外さない', async ({ page, context }) => {
  await open(page, context);
  await page.keyboard.press('p');
  await page.keyboard.press('z');

  // ポップアップブロックの再現。開けなかったときは null が返る
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByTestId('pin-bookmark-11').click();

  await expect(page.getByTestId('notice')).toContainText('ブロックされた');
  await expect(page.getByTestId('pin-list')).toContainText('朝刊の 1 本目');
});

test('送り先は端末ごとに変えられる', async ({ page, context }) => {
  await open(page, context);
  await page.getByTestId('open-manager').click();
  const input = page.getByTestId('bookmark-template');
  // 既定のままなら空欄で、ひな形は placeholder に出す
  await expect(input).toHaveValue('');

  // 使えないひな形は覚えない
  await input.fill('https://bm.example.com/add');
  await input.blur();
  await expect(page.getByTestId('feed-error')).toContainText('{url}');
  await expect(input).toHaveValue('');

  await input.fill('https://bm.example.com/add?u={url}&t={title}');
  await input.blur();
  await page.getByRole('button', { name: '閉じる（Esc）' }).click();

  const opened = context.waitForEvent('page');
  await page.keyboard.press('b');
  const target = new URL((await opened).url());
  expect(target.origin + target.pathname).toBe('https://bm.example.com/add');
  expect(target.searchParams.get('u')).toBe('https://example.com/1/entries/11');
  expect(target.searchParams.get('t')).toBe('朝刊の 1 本目');

  // 再読み込みしても覚えている
  await page.reload();
  await expect(title(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-manager').click();
  await expect(page.getByTestId('bookmark-template')).toHaveValue(
    'https://bm.example.com/add?u={url}&t={title}',
  );
});
