import { expect, test, type Page } from '@playwright/test';
import {
  type ApiRecorder,
  ENTRIES,
  entry,
  feedsWith,
  FEEDS,
  mockApi,
  syncResponse,
} from './fixtures';

/**
 * バックグラウンドでの自動更新と、タブのアイコンでの知らせ（issue #7）。
 *
 * 定期ポーリングそのものは docs/API.md の「起動後の定期ポーリング（既定 5 分間隔）と、
 * タブがフォアグラウンドに戻ったときに叩く」の実装。ここでは後者を試す
 * （5 分の経過は E2E では待てない）。
 */

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** タブを隠して戻す。フォアグラウンド復帰の契機を起こす */
async function returnToTab(page: Page): Promise<void> {
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
}

/**
 * Access のセッション切れを起こす。サーバは 401 ではなく、別オリジンの
 * ログイン画面へのリダイレクトを返す（issue #7）
 */
async function expireSession(page: Page, pattern = '**/api/sync*'): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 302,
      headers: { location: 'https://kanf.cloudflareaccess.com/cdn-cgi/access/login/example' },
    }),
  );
}

/**
 * 全て読み終えた状態にして開く。押す回数はフィードの本数に紐付くので 1 箇所に置く
 * （朝刊 2 本 + 夕刊 1 本 + 未読 0 のフィード）
 */
async function readEverything(page: Page): Promise<ApiRecorder> {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  for (let i = 0; i < 5; i++) await page.keyboard.press('S');
  await expect(page.getByTestId('finished')).toBeVisible();
  return recorder;
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
  const recorder = await readEverything(page);

  // **全フィードを返す。** 本番の GET /api/sync は一覧を全件返す（docs/API.md）。
  // 1 本だけ返すと setFeeds が現在のフィードを見失い、「購読が消えたときの逃がし」
  // 経路で座り直してしまう。読み終えた状態から座り直せるかを試せなくなる
  recorder.nextSync.push(
    syncResponse({
      feeds: feedsWith(1, { readSeq: 0, unreadCount: 1 }),
      newEntries: [entry(31, 1, '読み終えた後に届いた記事', '<p>新着</p>')],
      maxEntryId: 31,
    }),
  );

  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(1);

  // 読み終えた画面から、届いた新着へ移っている
  await expect(page.getByTestId('entry-title')).toHaveText('読み終えた後に届いた記事');
});

test('ヘッダのリロードで、いま届いている分を取りに行く', async ({ page }) => {
  // 定期ポーリングは 5 分間隔で、タブに戻ったときも間引きが効く。押せば待たずに済む
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  recorder.nextSync.push(
    syncResponse({
      feeds: [{ ...FEEDS[0], unreadCount: 3 }],
      newEntries: [entry(31, 1, 'リロードで届いた新着', '<p>新着</p>')],
      maxEntryId: 31,
    }),
  );

  await page.getByTestId('reload').click();

  await expect.poll(() => recorder.syncCalls.length).toBe(1);
  await expect(page.getByTestId('notice')).toHaveText('1 件の新着を取得した');
  // 定期同期と同じ経路なので、読んでいる場所は動かない
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  await expect(page.getByText('リロードで届いた新着')).toBeVisible();
});

test('新着が無ければ、押した結果としてそう出す', async ({ page }) => {
  // 画面が何も変わらない操作なので、黙って終わると押せたのかどうかが分からない
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  await page.getByTestId('reload').click();

  await expect(page.getByTestId('notice')).toHaveText('新着は無かった');
});

test('読み終えた画面のリロードから、届いた新着へそのまま入る', async ({ page }) => {
  const recorder = await readEverything(page);

  recorder.nextSync.push(
    syncResponse({
      feeds: feedsWith(1, { readSeq: 0, unreadCount: 1 }),
      newEntries: [entry(31, 1, '押して届いた記事', '<p>新着</p>')],
      maxEntryId: 31,
    }),
  );

  await page.getByTestId('finished-reload').click();

  await expect(page.getByTestId('entry-title')).toHaveText('押して届いた記事');
});

test('読み終えた画面で r を押しても、届いた新着から読み始められる', async ({ page }) => {
  // 記事が増える経路は差分同期だけではない。r（フィード単位の取り直し）でも
  // 座り直せないと、「1 件の新着を取得した」と出たまま画面は動かない
  await readEverything(page);

  // 読み終えた時点のカーソルは夕刊（最後に読んだフィード）に残っている
  await page.route('**/api/feeds/2/fetch', async (route) => {
    await route.fulfill({
      json: {
        feed: { ...FEEDS[1], unreadCount: 1 },
        entries: [entry(31, 2, 'r で届いた記事', '<p>新着</p>')],
      },
    });
  });

  await page.keyboard.press('r');

  await expect(page.getByTestId('notice')).toHaveText('1 件の新着を取得した');
  await expect(page.getByTestId('entry-title')).toHaveText('r で届いた記事');
});

test('読み終えていると、タブに戻ったときの間引きを詰める', async ({ page }) => {
  const recorder = await readEverything(page);

  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(1);

  // 続けて行き来しただけでは叩かない。往復が積み上がるのを避ける
  await returnToTab(page);
  await page.waitForTimeout(500);
  expect(recorder.syncCalls).toHaveLength(1);

  // 少し置けば叩く。読んでいる最中と同じ 30 秒を当てると、戻ってきても
  // 「全て読み終えた」が出たままになる
  await page.waitForTimeout(3000);
  await returnToTab(page);
  await expect.poll(() => recorder.syncCalls.length).toBe(2);
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

test('セッションが切れたら、読んでいる最中は帯で知らせるだけに留める', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  await expireSession(page);

  await returnToTab(page);

  // 待っても直らない。繋がらないときの帯とは別に出す
  await expect(page.getByTestId('signed-out')).toBeVisible();
  // **読みかけごとログイン画面へ持っていかない。** 押すかどうかは本人に委ねる
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
});

test('セッションが切れた後にタブを離れると、読み込み直して繋がった状態にする', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');
  await expireSession(page);
  await returnToTab(page);
  await expect(page.getByTestId('signed-out')).toBeVisible();

  const booted = recorder.bootstrapCalls;
  // **読んでいる最中には飛ばさない。** 隠れてから済ませる
  await setVisibility(page, 'hidden');

  await expect.poll(() => recorder.bootstrapCalls).toBeGreaterThan(booted);
});

test('読み込み直しても直らないときは、裏で繰り返さない', async ({ page }) => {
  // 画面は配られるのに API だけ弾かれる状況。数えていないと裏で延々と読み込み直す
  await mockApi(page);
  // recorder は数えられない（下の route が API を丸ごと横取りするので、
  // fixtures のハンドラまで届かない）。読み込み直したかどうかは load で数える
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目');

  await expireSession(page, '**/api/**');
  // 既読の送信も同じリダイレクトに当たる（判定は lib/api.ts の 1 箇所）
  await page.keyboard.press('j');
  await expect(page.getByTestId('signed-out')).toBeVisible();

  // 1 回目は読み込み直す
  await setVisibility(page, 'hidden');
  await expect.poll(() => loads).toBe(2);

  // その先でも弾かれたら諦める。手元のデータで読めるので、帯だけ出して本人に委ねる
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await setVisibility(page, 'hidden');
  await page.waitForTimeout(500);
  expect(loads).toBe(2);
});
