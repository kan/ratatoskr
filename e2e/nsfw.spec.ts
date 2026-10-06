import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * NSFW のフィードを隠す（issue #23）。
 *
 * 印はフィード単位でサーバに持ち、出すかどうかは端末ごとに決める。絞り込みそのものは
 * Vitest（stores/feeds.test.ts）で見ているので、ここでは画面から付け外しできること、
 * 隠した端末のどこにも出ないこと、端末の設定を覚えていることを確認する。
 */

const title = (page: Page) => page.getByTestId('entry-title');

async function open(page: Page) {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目', { timeout: 15_000 });
  return recorder;
}

async function openManager(page: Page) {
  await page.getByTestId('open-manager').click();
  await expect(page.getByTestId('subscription-manager')).toBeVisible();
}

const closeManager = (page: Page) => page.getByRole('button', { name: '閉じる（Esc）' }).click();

test('印を付けたフィードは、その場で一覧から消える。表示を入れると戻る', async ({ page }) => {
  const recorder = await open(page);
  await openManager(page);

  await page.getByTestId('manage-nsfw-2').click();
  await expect.poll(() => recorder.updates).toContainEqual({ id: 2, params: { nsfw: true } });
  // 既定は隠す。購読管理の一覧からも外す
  await expect(page.getByTestId('manage-feed-2')).toBeHidden();
  await expect(page.getByTestId('subscription-manager')).toContainText('この端末では隠している');

  await closeManager(page);
  await expect(page.getByTestId('feed-1')).toBeVisible();
  await expect(page.getByTestId('feed-2')).toBeHidden();

  // s で進んでも、隠したフィードには入らない。朝刊の先に未読のあるフィードは
  // もう無いので、そのまま読み終える
  await page.keyboard.press('s');
  await expect(page.getByTestId('finished')).toBeVisible();

  await openManager(page);
  await page.getByTestId('nsfw-visible').check();
  await expect(page.getByTestId('manage-feed-2')).toBeVisible();
  await expect(page.getByTestId('manage-nsfw-2')).toHaveAttribute('aria-pressed', 'true');

  await closeManager(page);
  await expect(page.getByTestId('feed-2')).toBeVisible();
});

test('表示するかどうかは端末が覚えている', async ({ page }) => {
  await open(page);
  await openManager(page);
  await expect(page.getByTestId('nsfw-visible')).not.toBeChecked();
  await page.getByTestId('nsfw-visible').check();

  await page.reload();
  await expect(title(page)).toBeVisible({ timeout: 15_000 });
  await openManager(page);
  await expect(page.getByTestId('nsfw-visible')).toBeChecked();
});

test('隠したフィードの記事に立てたピンも出さない', async ({ page }) => {
  await open(page);
  // 朝刊と夕刊で 1 本ずつピンする
  await page.keyboard.press('p');
  await page.keyboard.press('s');
  await expect(title(page)).toHaveText('夕刊の 1 本目');
  await page.keyboard.press('p');
  await expect(page.getByTestId('open-pins')).toHaveText('ピン（2）');

  await openManager(page);
  await page.getByTestId('manage-nsfw-2').click();
  await expect(page.getByTestId('manage-feed-2')).toBeHidden();
  await closeManager(page);

  // 読んでいた夕刊からは追い出される
  await expect(title(page)).not.toHaveText('夕刊の 1 本目');
  await expect(page.getByTestId('open-pins')).toHaveText('ピン（1）');

  await page.keyboard.press('z');
  const list = page.getByTestId('pin-list');
  await expect(list).toContainText('朝刊の 1 本目');
  await expect(list).not.toContainText('夕刊の 1 本目');
});
