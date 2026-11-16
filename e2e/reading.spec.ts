import { expect, test } from '@playwright/test';
import { mockApi, openApp } from './fixtures';

/**
 * 翻訳の切り替え（issue #42）と、読み方のデータ（issue #43）。
 */

test('訳した記事は訳文で出し、t で原文に切り替え、記事を移ると訳文に戻る', async ({ page }) => {
  await mockApi(page, {
    translations: { 11: { title: '朝刊の 1 本目（訳）', body: '<p>訳した本文</p>' } },
  });
  await openApp(page);

  const title = page.getByTestId('entry-title');
  await expect(title).toHaveText('朝刊の 1 本目（訳）');
  await expect(page.getByText('訳した本文')).toBeVisible();
  await expect(page.getByTestId('entry-translated')).toBeVisible();

  await page.keyboard.press('t');
  await expect(title).toHaveText('朝刊の 1 本目');
  await expect(page.getByTestId('entry-translated')).toBeHidden();

  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(title).toHaveText('朝刊の 1 本目（訳）');
});

test('記事を移ると表示していた時間を、v で元記事を開いたことを送る', async ({ page, context }) => {
  const api = await mockApi(page);
  await openApp(page);
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  // 新しいタブは開かせて閉じる（元記事の URL はモックしていない）
  context.on('page', (opened) => void opened.close());
  await page.keyboard.press('v');
  await page.waitForTimeout(1_500);
  await page.keyboard.press('j');
  // 読み方のデータは溜めてから送る。タブを離れた時点で出し切るので、それを起こす
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect
    .poll(() => api.events.map((event) => event.kind).sort(), { timeout: 10_000 })
    .toEqual(['dwell', 'open']);
  const dwell = api.events.find((event) => event.kind === 'dwell');
  expect(dwell).toMatchObject({ entryId: 11, feedId: 1 });
  expect(dwell?.kind === 'dwell' && dwell.seconds).toBeGreaterThanOrEqual(1);
});
