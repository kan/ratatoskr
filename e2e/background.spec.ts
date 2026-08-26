import { expect, test, type Page } from '@playwright/test';
import { ENTRIES, entry, FEEDS, mockApi, syncResponse } from './fixtures';

/**
 * バックグラウンドでの自動更新と、タブのアイコンでの知らせ（issue #7）。
 *
 * 定期ポーリングそのものは docs/API.md の「起動後の定期ポーリング（既定 5 分間隔）と、
 * タブがフォアグラウンドに戻ったときに叩く」の実装。ここでは後者を試す
 * （5 分の経過は E2E では待てない）。
 */

/** タブを隠して戻す。フォアグラウンド復帰の契機を起こす */
async function returnToTab(page: Page): Promise<void> {
  for (const state of ['hidden', 'visible']) {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  }
}

const iconHrefs = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel="icon"]'), (el) => el.getAttribute('href')),
  );

test('タブに戻ると差分同期を叩く', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  expect(recorder.syncCalls).toHaveLength(0);

  await returnToTab(page);

  await expect.poll(() => recorder.syncCalls.length).toBe(1);
  // 手元が持つ最大 entry id をカーソルとして送る（docs/API.md）
  expect(recorder.syncCalls[0]).toContain('entryCursor=21');
});

test('同期で届いた新着が、読んでいる場所を動かさずに増える', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  recorder.nextSync.push(
    syncResponse({
      feeds: [{ ...FEEDS[0], unreadCount: 3 }],
      newEntries: [entry(31, 1, '同期で届いた新着', '<p>新着</p>')],
      maxEntryId: 31,
    }),
  );

  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(1);

  // カーソルは動かさない。読んでいた記事のまま
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  // 新着は一覧に足される
  await expect(page.getByText('同期で届いた新着')).toBeVisible();
});

test('全て読み終えた後に届いた新着へ、キーで辿り着ける', async ({ page }) => {
  // 読み切った画面ではカーソルがどのフィードにも居ない。同期で新着が届いたときに
  // 取り直さないと、アイコンは未読ありに変わるのに j も s も無反応になる
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  for (let i = 0; i < 5; i++) await page.keyboard.press('S');
  await expect(page.getByTestId('finished')).toBeVisible();

  recorder.nextSync.push(
    syncResponse({
      feeds: [{ ...FEEDS[0], readSeq: 0, unreadCount: 1 }],
      newEntries: [entry(31, 1, '読み終えた後に届いた記事', '<p>新着</p>')],
      maxEntryId: 31,
    }),
  );

  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(1);

  // 読み終えた画面から、届いた新着へ移っている
  await expect(page.getByTestId('entry-title')).toHaveText('読み終えた後に届いた記事');
});

test('同期でフィードの並びが組み替わらない', async ({ page }) => {
  // サーバの並びは未読数を含むので、読み進めるそばから順序が変わる。同期のたびに
  // 組み替えると、前方向にしか進まない s が未読を飛ばして「全て読み終えた」に着く
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('position')).toContainText('朝刊');

  const before = await feedOrder(page);
  // サーバが逆順で返しても、読んでいる間は手元の並びを保つ
  recorder.nextSync.push(syncResponse({ feeds: [...FEEDS].reverse() }));

  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(1);

  expect(await feedOrder(page)).toEqual(before);
});

test('起動時はサーバの並びを採る（他の端末で変えたレートが効く）', async ({ page }) => {
  // 並びを保つのは読んでいる最中の差し替えだけ。起動時まで手元の並びを優先すると、
  // 他の端末で変えたレートがそのセッション中ずっと効かない
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  expect((await feedOrder(page))[0]).toBe('feed-1');

  // 他の端末でレートを変えた形。サーバが返す並びだけが入れ替わる
  const swapped = [FEEDS[1], FEEDS[0], ...FEEDS.slice(2)];
  await page.route('**/api/bootstrap*', async (route) => {
    await route.fulfill({
      json: {
        serverTime: 1786000100,
        schemaVersion: 3,
        feeds: swapped,
        entries: ENTRIES,
        pins: [],
        maxEntryId: 21,
      },
    });
  });

  // 手元（IndexedDB）には前の並びが残っている状態で開き直す
  await page.reload();
  await expect(page.getByTestId('entry-title')).toBeVisible();

  await expect.poll(async () => (await feedOrder(page))[0]).toBe('feed-2');
});

test('未読が無くなるとタブのアイコンが沈む', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  // 未読があるうちは通常のアイコン
  expect(await iconHrefs(page)).toEqual(['/favicon.svg', '/favicon.png']);

  // 全て読み終えるまで送る（朝刊 2 本 + 夕刊 1 本）
  for (let i = 0; i < 5; i++) await page.keyboard.press('S');

  await expect.poll(() => iconHrefs(page)).toEqual(['/favicon-muted.svg', '/favicon-muted.png']);
});

/** 左ペインに並んでいるフィードを、順番どおりに（testid は feed-<id>） */
async function feedOrder(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('feed-list')
    .locator('[data-testid^="feed-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
}
