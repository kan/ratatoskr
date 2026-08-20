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

  // 404 は 1 回でも対象。応答なしは 2 回続いたものだけ。接続断は対象外
  const bar = page.getByTestId('unreachable-bar');
  await expect(bar).toContainText('2 件');

  await page.getByTestId('toggle-problems').click();
  await expect(page.getByTestId('manage-feed-4')).toBeVisible();
  await expect(page.getByTestId('manage-feed-5')).toBeVisible();
  await expect(page.getByTestId('manage-feed-6')).toBeHidden();
  await expect(page.getByTestId('manage-feed-7')).toBeHidden();
  await expect(page.getByTestId('manage-feed-1')).toBeHidden();

  await page.getByTestId('remove-unreachable').click();

  // 並列に投げるので届く順は決まらない
  await expect.poll(() => [...recorder.deleted].sort()).toEqual([4, 5]);
  // 一時的な失敗のフィードは残す
  await expect(page.getByTestId('unreachable-bar')).toBeHidden();
  await expect(page.getByTestId('manage-feed-6')).toBeVisible();
  await expect(page.getByTestId('manage-feed-7')).toBeVisible();
});

/**
 * 全文取得（M7）。要約しか配信しないフィードで、記事ページから本文を取ってくる設定。
 * 抽出そのものは Vitest（src/crawler/）で見ているので、ここでは画面から入切できて
 * その場で取りに行くことだけを見る。
 */
test('要約しか配信しないフィードには全文取得を勧める', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();

  await expect(page.getByTestId('manage-full-text-hint-2')).toBeVisible();
  // 勧めるのは要約だけのフィードに限る。朝刊は本文を配っている
  await expect(page.getByTestId('manage-full-text-hint-1')).toBeHidden();
});

test('全文取得を入れると、その場で取りに行く', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();

  await expect(page.getByTestId('manage-full-text-2')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('manage-full-text-2').click();

  await expect.poll(() => recorder.updates).toEqual([{ id: 2, params: { fullText: true } }]);
  // 設定だけ変えて次の定期取得を待たせると「入れたのに何も変わらない」ように見える
  await expect.poll(() => recorder.refetched).toEqual([2]);
  // 文言は入切で変えない（変えると幅が動いて後ろのボタンがずれる）。
  // 状態はトグルとしての aria-pressed で見る
  await expect(page.getByTestId('manage-full-text-2')).toHaveAttribute('aria-pressed', 'true');
});

/**
 * 購読の絞り込み（issue #1）。購読が増えると、目的の 1 件に辿り着く手間が
 * 操作の大半を占める。
 */
test('名前・URL・フォルダで購読を絞り込める', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();

  await page.getByTestId('feed-search').fill('夕刊');
  await expect(page.getByTestId('manage-feed-2')).toBeVisible();
  await expect(page.getByTestId('manage-feed-1')).toBeHidden();
  await expect(page.getByTestId('search-count')).toContainText('1 / 7 件');

  // URL でも引ける（同じ名前のブログを URL で見分けたいことがある）
  await page.getByTestId('feed-search').fill('example.com/3/feed');
  await expect(page.getByTestId('manage-feed-3')).toBeVisible();
  await expect(page.getByTestId('manage-feed-1')).toBeHidden();

  // 一致しないときは、そう分かるようにする
  await page.getByTestId('feed-search').fill('存在しないフィード');
  await expect(page.getByTestId('no-matching-feeds')).toBeVisible();

  await page.getByTestId('clear-search').click();
  await expect(page.getByTestId('manage-feed-1')).toBeVisible();
});

test('絞り込み中でもレート変更がそのまま効く', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();
  await page.getByTestId('feed-search').fill('夕刊');

  await page.getByTestId('manage-feed-2').locator('select').selectOption('5');

  await expect.poll(() => recorder.updates).toEqual([{ id: 2, params: { rate: 5 } }]);
});

test('「問題のあるフィードだけ」と絞り込みは重ねて効く', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByTestId('open-manager').click();

  await page.getByTestId('toggle-problems').click();
  await expect(page.getByTestId('manage-feed-4')).toBeVisible();
  await expect(page.getByTestId('manage-feed-5')).toBeVisible();

  await page.getByTestId('feed-search').fill('消えた');
  await expect(page.getByTestId('manage-feed-4')).toBeVisible();
  await expect(page.getByTestId('manage-feed-5')).toBeHidden();
});
