import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * 既読同期（M4）。読んだところがサーバへ送られること、u で未読に戻した記事が
 * 送信と再読み込みの両方を越えて残ることを見る。
 *
 * 送信は outbox の debounce（2 秒）とバックオフの後に走るので、待ちは長めに取る。
 */

const SEND_TIMEOUT = 15_000;
/** 再読み込み後の起動待ち。IndexedDB の読み出しと bootstrap を挟むので既定より長く取る */
const BOOT_TIMEOUT = 15_000;

test('読んだところまでの既読がサーバに送られる', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');

  // 表示した記事までのウォーターマークが届く。まとめて 1 回で送られる
  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 1, watermark: 12 });
});

test('u で未読に戻した記事はサーバに送られ、再読み込み後もその記事から読める', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  await page.keyboard.press('u');
  // 未読に戻したので左ペインの数字が戻る
  await expect(page.getByTestId('feed-1')).toContainText('(1)');

  await expect
    .poll(() => recorder.unreadCalls, { timeout: SEND_TIMEOUT })
    .toContainEqual({ entryId: 12, unread: true });

  await page.reload();
  // 既読は手元に残っているので朝刊の 1 本目には戻らず、未読に戻した記事から出る
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目', {
    timeout: BOOT_TIMEOUT,
  });
});

test('起動直後に表示した記事の既読も送られる', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  // 起動を待ってからキーを押す。描画前のキーは誰も受け取らない
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 1, watermark: 12 });

  // 再読み込みすると、手元の続き（夕刊の 1 本目）を表示した状態から始まる。
  // この既読は起動シーケンスの中で進むので、取りこぼすと他の端末に伝わらない
  recorder.readMarks.length = 0;
  await page.reload();
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 2, watermark: 21 });
});

test('未読に戻した記事を読み直すと、その取り消しが手元とサーバの両方に届く', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  // 起動を待ってからキーを押す。描画前のキーは誰も受け取らない
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  await page.keyboard.press('u');
  await expect
    .poll(() => recorder.unreadCalls, { timeout: SEND_TIMEOUT })
    .toContainEqual({ entryId: 12, unread: true });

  // 再読み込みで表示 = 読み直したので、未読の例外は外れる
  await page.reload();
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目', {
    timeout: BOOT_TIMEOUT,
  });
  await expect
    .poll(() => recorder.unreadCalls, { timeout: SEND_TIMEOUT })
    .toContainEqual({ entryId: 12, unread: false });

  // 外れた以上、次の起動では未読に戻らない
  await page.reload();
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });
});
