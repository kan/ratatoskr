import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * 手元に残した既読が、再読み込みしても生き残ることの確認。
 *
 * M3 の時点では既読をサーバに送っていないので、サーバは常に「未読 2 件」と
 * 答えてくる。それに上書きされて読んだ記事が復活しないことを見る
 * （read_seq は単調増加でなければならない。CLAUDE.md の不変条件 1）。
 */

/** IndexedDB に書き戻された read_seq を読む */
async function storedReadSeq(page: Page, feedId: number): Promise<number | null> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ratatoskr');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ id: number; readSeq: number }[]>((resolve) => {
      const request = database.transaction('feeds').objectStore('feeds').getAll();
      request.onsuccess = () => resolve(request.result as { id: number; readSeq: number }[]);
    });
    return rows.find((feed) => feed.id === id)?.readSeq ?? null;
  }, feedId);
}

test('読み終えたフィードは再読み込み後も既読のまま', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByTestId('entry-title').waitFor();
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  // 表示した記事から順に既読になる
  await expect(page.getByTestId('feed-1')).toContainText('(1)');
  await page.keyboard.press('j');
  await expect(page.getByTestId('feed-1')).not.toContainText('(1)');

  // 手元への書き戻しを待つ（debounce があるので値で待つ）
  await expect.poll(() => storedReadSeq(page, 1)).toBe(12);

  await page.reload();
  // サーバは相変わらず未読 2 件と答えるが、手元の既読が勝つ
  await expect(page.getByTestId('feed-1')).not.toContainText('(2)');
  // 未読の残っているフィードから読み始める
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目');
  // 起動時の bootstrap で上書きされていないこと
  await expect.poll(() => storedReadSeq(page, 1)).toBe(12);
});
