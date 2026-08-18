import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';
import { SCHEMA_VERSION } from '../shared/types';

/**
 * 手元に残した既読が、再読み込みしても生き残ることの確認。
 *
 * このモックのサーバは既読を受け取っても常に「未読 2 件」と答えてくる
 * （送信が届く前に再読み込みした状態にあたる）。それに上書きされて読んだ記事が
 * 復活しないことを見る（read_seq は単調増加。CLAUDE.md の不変条件 1）。
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

/**
 * 別のタブが古い版のまま接続を握っていると、IndexedDB のスキーマ更新が始められず
 * openDB は解決も失敗もしない。手元の読み出しを待ち続けて「読み込み中…」で
 * 止まらないことを見る（M6 で SCHEMA_VERSION を 3 に上げたときに実際に踏んだ）。
 */
test('古い版のタブが接続を握っていても、サーバのデータで起動する', async ({ page, context }) => {
  // アプリを動かさない同一オリジンのページで、1 つ前の版の接続を握らせる
  const holder = await context.newPage();
  await holder.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>holder</body></html>' }),
  );
  await holder.goto('/holder');
  await holder.evaluate(
    (version) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('ratatoskr', version);
        request.onupgradeneeded = () => request.result.createObjectStore('meta');
        request.onsuccess = () => {
          // 参照を残して接続を開いたままにする（古いコードは versionchange で閉じない）
          (window as unknown as { held: IDBDatabase }).held = request.result;
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
    SCHEMA_VERSION - 1,
  );

  await mockApi(page);
  await page.goto('/');

  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  // 手元に保存できないことは黙って続けずに画面に出す
  await expect(page.getByTestId('local-error')).toContainText('古い版');
});
