import { expect, test, type Page } from '@playwright/test';
import { ENTRIES, FEEDS, mockApi } from './fixtures';
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

/**
 * 保持期間を過ぎた記事を手元からも捨てること（M9）。
 *
 * サーバ側の削除は差分（sinceId）に載らないので、こちらで同じ規則で捨てないと、
 * 同期した記事が端末に永久に積み上がる。
 */
test('保持期間を過ぎた既読記事は手元からも消える', async ({ page }) => {
  await mockApi(page);
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;

  // 既読（read_seq より前）で、40 日前に取り込んだ記事を 1 件だけ持つフィード。
  // 同じフィードに保持期間の中の記事も置き、そちらは残ることを見る
  const feed = { ...FEEDS[0], id: 1, readSeq: 600, unreadCount: 0 };
  const old = { ...ENTRIES[0], id: 500, feedId: 1, storedAt: now - 40 * day };
  const fresh = { ...ENTRIES[0], id: 501, feedId: 1, storedAt: now - 10 * day };

  await page.route('**/api/bootstrap*', (route) =>
    route.fulfill({
      json: {
        serverTime: now,
        schemaVersion: SCHEMA_VERSION,
        feeds: [feed],
        entries: [old, fresh],
        pins: [],
        maxEntryId: 501,
      },
    }),
  );
  await page.route('**/api/entries*', (route) =>
    route.fulfill({ json: { entries: [], nextSinceId: null, hasMore: false } }),
  );

  await page.goto('/');
  // 未読が無いので読む記事は無い。起動が終わったことを画面で待ってから手元を見る
  await expect(page.getByTestId('finished')).toBeVisible();

  await expect.poll(() => storedEntryIds(page)).toEqual([501]);
});

/** IndexedDB に残っている記事の id */
async function storedEntryIds(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ratatoskr');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ id: number }[]>((resolve) => {
      const request = database.transaction('entries').objectStore('entries').getAll();
      request.onsuccess = () => resolve(request.result as { id: number }[]);
    });
    return rows.map((entry) => entry.id).sort((a, b) => a - b);
  });
}
