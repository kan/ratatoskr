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

/**
 * 手元の控えは、他の端末で読んだ分だけ遅れている（issue #10）。
 * 遅れた控えのまま座ると、向こうで読み終えたフィードの既読記事から始まってしまう。
 */
test('他の端末で読み終えたフィードからは始めない', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  // 控えが手元に残るのを待つ。ここまでが「前回のタブ」
  await expect.poll(() => storedReadSeq(page, 1)).toBe(11);

  // その後、別の端末で朝刊を読み終えた。サーバだけが先に進んでいる状態
  await page.route('**/api/bootstrap*', (route) =>
    route.fulfill({
      json: {
        serverTime: 1786000100,
        schemaVersion: SCHEMA_VERSION,
        feeds: FEEDS.map((feed) =>
          feed.id === 1 ? { ...feed, readSeq: 12, unreadCount: 0 } : feed,
        ),
        entries: ENTRIES,
        pins: [],
        maxEntryId: 21,
      },
    }),
  );

  await page.reload();
  // 手元の控えでは朝刊の 2 本目が未読だが、サーバの既読が届いた時点で座り直す
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目');
  await expect(page.getByTestId('feed-1')).not.toContainText('(');
});

/**
 * 間引きは「消してよい記事」を起動時に一度だけ決める。**その後に u を押した記事は、
 * 手元から消えたまま例外だけが残る。** 次の起動は「未読 1 件なのに出せる記事が無い」
 * 状態で始まり、繋がらなければ取り直すこともできない。
 * u を押した時点で本体を置き直していることを、繋がらない起動で確かめる。
 */
test('間引きの後に未読へ戻した記事も、繋がらない次の起動で読める', async ({ page }) => {
  await mockApi(page);
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;

  // 保持期間を過ぎた記事だけを持つフィード。読んだ端から間引きの対象になる
  const feed = { ...FEEDS[0], id: 1, readSeq: 0, unreadCount: 2 };
  const entries = ENTRIES.filter((entry) => entry.feedId === 1).map((entry) => ({
    ...entry,
    storedAt: now - 40 * day,
  }));
  await page.route('**/api/bootstrap*', (route) =>
    route.fulfill({
      json: {
        serverTime: now,
        schemaVersion: SCHEMA_VERSION,
        feeds: [feed],
        entries,
        pins: [],
        maxEntryId: 12,
      },
    }),
  );
  await page.route('**/api/entries*', (route) =>
    route.fulfill({ json: { entries: [], nextSinceId: null, hasMore: false } }),
  );

  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  await expect.poll(() => storedReadSeq(page, 1)).toBe(12);

  // 2 本とも読み終えた状態で起動し直すと、間引きが両方を手元から消す。
  // 間引きの正しさは上のテストが見ていて、ここは前提が整ったことの確認
  await page.reload();
  await expect(page.getByTestId('finished')).toBeVisible();
  await expect.poll(() => storedEntryIds(page)).toEqual([]);

  // 読み返しに戻って、2 本目を未読に戻す
  await page.getByTestId('feed-1').click();
  await page.getByTestId('entry-12').click();
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  await page.keyboard.press('u');
  // 例外を立てた記事は手元に戻っている
  await expect.poll(() => storedEntryIds(page)).toEqual([12]);

  // 繋がらない状態で起動しても、その記事から読める
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目', { timeout: 15_000 });
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
