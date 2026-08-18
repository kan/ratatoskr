import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * 購読管理（M5 の完了条件: UI からフィードを追加・削除できる）。
 *
 * 検出とクロールの正しさは Vitest 側で見ているので、ここでは画面から
 * 呼べること・結果が左ペインに出ることを確認する。
 */

test('購読を追加すると左ペインに出る', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();
  await expect(page.getByTestId('subscription-manager')).toBeVisible();

  await page.getByTestId('feed-url').fill('https://new.example.com/');
  await page.getByTestId('feed-add').click();

  await expect
    .poll(() => recorder.created)
    .toContainEqual({
      url: 'https://new.example.com/',
      rate: 3,
      folder: '',
    });
  await expect(page.getByTestId('manage-feed-9')).toBeVisible();

  await page.getByRole('button', { name: '閉じる（Esc）' }).click();
  await expect(page.getByTestId('feed-9')).toContainText('追加したフィード');
});

test('フィードが複数見つかったら候補から選ぶ', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();

  await page.getByTestId('feed-url').fill('https://multi.example.com/');
  await page.getByTestId('feed-add').click();

  const candidates = page.getByTestId('feed-candidates');
  await expect(candidates).toContainText('記事');
  await expect(candidates).toContainText('コメント');
  // 候補を出した時点では登録しない
  await expect(page.getByTestId('manage-feed-9')).toBeHidden();

  await candidates.getByRole('button', { name: /記事/ }).click();
  await expect(page.getByTestId('manage-feed-9')).toBeVisible();
  expect(recorder.created.at(-1)?.url).toBe('https://multi.example.com/rss');
});

test('購読を解除すると一覧から消える', async ({ page }) => {
  const recorder = await mockApi(page);
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await page.getByTestId('open-manager').click();
  await page.getByTestId('manage-delete-2').click();

  await expect.poll(() => recorder.deleted).toEqual([2]);
  await expect(page.getByTestId('manage-feed-2')).toBeHidden();
  await page.getByRole('button', { name: '閉じる（Esc）' }).click();
  await expect(page.getByTestId('feed-2')).toBeHidden();
});

test('数字キーでレートを変えると左ペインの並びが入れ替わる', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  // 読んでいる ★5 の「朝刊」を最下位に落とす
  const order = () => page.locator('[data-testid^="feed-"]').allTextContents();
  expect((await order())[0]).toContain('朝刊');

  await page.keyboard.press('1');
  await expect.poll(async () => (await order())[0]).toContain('夕刊');
  // 並びが変わってもカーソルは朝刊に乗ったまま
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  await expect
    .poll(() => recorder.updates, { timeout: 15_000 })
    .toContainEqual({
      id: 1,
      params: { rate: 1 },
    });
});

test('r で今すぐ取得し直す', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  await page.keyboard.press('r');
  await expect.poll(() => recorder.refetched).toEqual([1]);
});

test('取得できないフィードだけをまとめて解除できる', async ({ page }) => {
  const recorder = await mockApi(page);
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await page.getByTestId('open-manager').click();

  // 取りに行っても直らない失敗（404 / 応答なし）が対象。接続断は数に入れない
  const bar = page.getByTestId('unreachable-bar');
  await expect(bar).toContainText('2 件');

  await page.getByTestId('toggle-problems').click();
  await expect(page.getByTestId('manage-feed-4')).toBeVisible();
  await expect(page.getByTestId('manage-feed-5')).toBeVisible();
  await expect(page.getByTestId('manage-feed-6')).toBeHidden();
  await expect(page.getByTestId('manage-feed-1')).toBeHidden();

  await page.getByTestId('remove-unreachable').click();

  await expect.poll(() => recorder.deleted).toEqual([4, 5]);
  // 相手の一時障害で落ちているフィードは残す
  await expect(page.getByTestId('unreachable-bar')).toBeHidden();
  await expect(page.getByTestId('manage-feed-6')).toBeVisible();
});
