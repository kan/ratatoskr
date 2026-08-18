import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * ピン（M6）。「読む」と「後で処理する」を分ける機能なので、
 * ピンしても記事は切り替わらないこと、既読の進みに影響しないことを見る。
 */

const title = (page: Page) => page.getByTestId('entry-title');

/** 送信は outbox の debounce（2 秒）の後に走る */
const SEND_TIMEOUT = 15_000;

async function open(page: Page) {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目', { timeout: 15_000 });
  return recorder;
}

test('p でピンし、記事は切り替わらない', async ({ page }) => {
  const recorder = await open(page);

  await page.keyboard.press('p');
  // 記事は動かさない。押したことだけを知らせる
  await expect(title(page)).toHaveText('朝刊の 1 本目');
  await expect(page.getByTestId('notice')).toHaveText('ピンした');

  await expect
    .poll(() => recorder.pinned, { timeout: SEND_TIMEOUT })
    .toContainEqual({
      entryId: 11,
      title: '朝刊の 1 本目',
      url: 'https://example.com/1/entries/11',
    });
});

test('z でピン一覧を開閉する', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  await page.keyboard.press('j');
  await page.keyboard.press('p');

  await page.keyboard.press('z');
  const list = page.getByTestId('pin-list');
  await expect(list).toContainText('ピン（2）');
  await expect(list).toContainText('朝刊の 1 本目');
  await expect(list).toContainText('朝刊の 2 本目');

  // z でも Esc でも閉じる
  await page.keyboard.press('z');
  await expect(list).toBeHidden();
  await page.keyboard.press('z');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
});

test('ピンした記事も既読の進みは変わらない', async ({ page }) => {
  const recorder = await open(page);

  await page.keyboard.press('p');
  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  // ピンは既読とは独立している（docs/UX.md）
  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 1, watermark: 12 });
});

test('一覧から外すとサーバにも届く', async ({ page }) => {
  const recorder = await open(page);
  await page.keyboard.press('p');
  // サーバが id を振るまで待つ（外すには id が要る）
  await expect.poll(() => recorder.pinned.length, { timeout: SEND_TIMEOUT }).toBe(1);

  await page.keyboard.press('z');
  await page.getByTestId('pin-remove-11').click();
  await expect(page.getByTestId('pin-empty')).toBeVisible();

  await expect.poll(() => recorder.unpinned, { timeout: SEND_TIMEOUT }).toEqual([901]);
});

test('o でピンを新しいタブに開き、開けた分はピンから外す', async ({ page, context }) => {
  await open(page);
  await page.keyboard.press('p');

  await page.keyboard.press('z');
  const opened = context.waitForEvent('page');
  await page.keyboard.press('o');
  await opened;

  // 開き切ったら一覧は空になり、オーバーレイも閉じる（処理し終えたということ）
  await expect(page.getByTestId('pin-list')).toBeHidden();
  await expect(page.getByTestId('notice')).toHaveText('1 件をタブで開いた');

  await page.keyboard.press('z');
  await expect(page.getByTestId('pin-empty')).toBeVisible();
});

test('ブラウザにブロックされた分はピンから消さない', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  await page.keyboard.press('j');
  await page.keyboard.press('p');

  // ポップアップブロックの再現。開けなかったときは null が返る。
  // 実際のブラウザも、1 回の操作で 2 つ目以降のタブを塞ぐことがある
  await page.evaluate(() => {
    window.open = () => null;
  });

  await page.keyboard.press('z');
  await page.keyboard.press('o');

  // 開けなかったピンは残す。一覧も閉じない（個別に開けるように）
  await expect(page.getByTestId('pin-list')).toBeVisible();
  await expect(page.getByTestId('notice')).toContainText('2 件はブラウザにブロックされた');
  await expect(page.getByTestId('pin-list')).toContainText('ピン（2）');
});

test('ピンが立っている記事は左ペインと本文で分かる', async ({ page }) => {
  await open(page);

  await expect(page.getByTestId('entry-pinned')).toBeHidden();
  await expect(page.getByTestId('pinned-11')).toBeHidden();

  await page.keyboard.press('p');
  await expect(page.getByTestId('entry-pinned')).toBeVisible();
  await expect(page.getByTestId('pinned-11')).toBeVisible();

  // 外したら目印も消える
  await page.keyboard.press('p');
  await expect(page.getByTestId('entry-pinned')).toBeHidden();
  await expect(page.getByTestId('pinned-11')).toBeHidden();
});

test('知らせは次の記事に移ったら消える', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  await expect(page.getByTestId('notice')).toHaveText('ピンした');

  await page.keyboard.press('j');
  await expect(page.getByTestId('notice')).toBeHidden();
});
