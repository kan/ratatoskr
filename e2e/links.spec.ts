import { expect, test, type Page } from '@playwright/test';
import { BOOT_TIMEOUT, mockApi, openApp } from './fixtures';

/**
 * 記事内のリンク一覧（issue #32）。記事そのものではなく、記事が紹介している先を
 * ピンするための一覧。見るのは、本文からリンクを拾えること、一覧の中で j / k / p /
 * Enter が読み替わること、リンクだけをピンした記事にも左ペインの目印が出ること。
 */

const title = (page: Page) => page.getByTestId('entry-title');
const list = (page: Page) => page.getByTestId('link-list');

/** 送信は outbox の debounce（2 秒）の後に走る */
const SEND_TIMEOUT = 15_000;

const BODY =
  '<p>紹介します <a href="https://shop.example.com/a">紹介先 A</a>' +
  ' <a href="https://bsky.app/hashtag/foo">#foo</a>' +
  ' <a href="https://bsky.app/profile/did:plc:x">@someone</a></p>' +
  '<figure><a href="https://shop.example.com/b"><img src="https://img.example.com/b.jpg" alt=""></a>' +
  '<figcaption><a href="https://shop.example.com/b">紹介先 B</a></figcaption></figure>';

async function open(page: Page) {
  const recorder = await mockApi(page, { bodies: { 11: BODY } });
  await openApp(page);
  await expect(title(page)).toHaveText('朝刊の 1 本目', { timeout: BOOT_TIMEOUT });
  return recorder;
}

test('l で、この記事と本文のリンクを並べる。タグとメンションと重複は除く', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('open-links')).toHaveText('リンク (2)');

  await page.keyboard.press('l');
  await expect(list(page)).toBeVisible();
  await expect(page.getByTestId('link-0')).toContainText('この記事');
  await expect(page.getByTestId('link-0')).toContainText('朝刊の 1 本目');
  await expect(page.getByTestId('link-1')).toContainText('紹介先 A');
  // 画像とキャプションが同じ先を指すカードは 1 行。呼び名はキャプションの文字
  await expect(page.getByTestId('link-2')).toContainText('紹介先 B');
  await expect(page.getByTestId('link-3')).toHaveCount(0);

  // l でも Esc でも閉じる
  await page.keyboard.press('l');
  await expect(list(page)).toBeHidden();
  await page.keyboard.press('l');
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeHidden();
});

test('一覧の中では j / k で選び、p でリンクをピンする。記事のピンにはならない', async ({
  page,
}) => {
  const recorder = await open(page);

  await page.keyboard.press('l');
  await page.keyboard.press('j');
  await expect(page.getByTestId('link-1')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('p');
  await expect(page.getByTestId('link-pin-1')).toHaveAttribute('aria-pressed', 'true');

  await expect
    .poll(() => recorder.pinned, { timeout: SEND_TIMEOUT })
    .toContainEqual({ entryId: 11, title: '紹介先 A', url: 'https://shop.example.com/a' });

  // 記事は切り替わらず、記事そのものにピンは立たない
  await page.keyboard.press('Escape');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
  await expect(page.getByTestId('entry-pinned')).toHaveCount(0);
  // それでも左ペインには、この記事から何かをピンした目印が出る
  await expect(page.getByTestId('pinned-11')).toBeVisible();

  // 閉じた後の j は記事送りに戻る
  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('朝刊の 2 本目');
});

test('一覧の中でもう一度 p を押すと外れる', async ({ page }) => {
  const recorder = await open(page);
  await page.keyboard.press('l');
  await page.keyboard.press('j');
  await page.keyboard.press('p');
  // 外すにはサーバの id が要る
  await expect.poll(() => recorder.pinned.length, { timeout: SEND_TIMEOUT }).toBe(1);

  await page.keyboard.press('p');
  await expect(page.getByTestId('link-pin-1')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => recorder.unpinned.length, { timeout: SEND_TIMEOUT }).toBe(1);
});

test('先頭の「この記事」で p を押すと、記事のピンになる', async ({ page }) => {
  const recorder = await open(page);
  await page.keyboard.press('l');
  await page.keyboard.press('p');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('entry-pinned')).toBeVisible();
  await expect
    .poll(() => recorder.pinned, { timeout: SEND_TIMEOUT })
    .toContainEqual({
      entryId: 11,
      title: '朝刊の 1 本目',
      url: 'https://example.com/1/entries/11',
    });
});

test('Enter で選んだリンクを新しいタブで開き、一覧は閉じない', async ({ page, context }) => {
  await context.route('https://shop.example.com/**', (route) =>
    route.fulfill({ body: '<p>紹介先</p>', contentType: 'text/html' }),
  );
  await open(page);
  await page.keyboard.press('l');
  await page.keyboard.press('j');

  const opened = context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const tab = await opened;
  await expect.poll(() => tab.url()).toBe('https://shop.example.com/a');

  await expect(list(page)).toBeVisible();
});

test.describe('狭い画面', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('見出しの横のボタンで一覧を開き、行のボタンでピンする', async ({ page }) => {
    const recorder = await open(page);

    await page.getByTestId('open-links').tap();
    await expect(list(page)).toBeVisible();
    await page.getByTestId('link-pin-2').tap();
    await expect(page.getByTestId('link-pin-2')).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => recorder.pinned, { timeout: SEND_TIMEOUT })
      .toContainEqual({ entryId: 11, title: '紹介先 B', url: 'https://shop.example.com/b' });

    await page.getByTestId('link-close').tap();
    await expect(list(page)).toBeHidden();
  });
});
