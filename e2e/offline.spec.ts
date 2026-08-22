import { expect, test, type Page, type Route } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * オフラインで読んだ分が、復帰後に届くこと（M8 の完了条件）。
 *
 * outbox（M4）は IndexedDB に永続化されているので、送信に失敗しても、タブを
 * 閉じても失われない。ここで見るのは「繋がらない間に読み進めた既読が、
 * 再読み込みを跨いでも残り、復帰した時点で送られる」という一続きの経路。
 *
 * 繋がらない状態は、送信先の route を落として作る。API はテストが握っていて
 * （fixtures.ts）、context.setOffline では素通りしてしまうため。
 */

const BOOT_TIMEOUT = 15_000;
const SEND_TIMEOUT = 15_000;

/** 送信だけが落ちる状態を作る。後で外せるよう handler を返す */
async function cutRead(page: Page): Promise<(route: Route) => Promise<void>> {
  const abort = async (route: Route): Promise<void> => {
    await route.abort('internetdisconnected');
  };
  // 後から足した route が先に当たる（mockApi の分は残したまま塞ぐ）
  await page.route('**/api/read', abort);
  return abort;
}

/** 復帰。繋ぎ直したことを知らせると outbox はバックオフを待たずに送る */
async function restore(page: Page, abort: (route: Route) => Promise<void>): Promise<void> {
  await page.unroute('**/api/read', abort);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

test('繋がらない間に読んだ分は、復帰した時点で送られる', async ({ page }) => {
  const recorder = await mockApi(page);
  const abort = await cutRead(page);

  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });

  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');

  // 送信は落ちているが、読む方は最後まで進められる
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目');
  expect(recorder.readMarks).toEqual([]);

  await restore(page, abort);

  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 1, watermark: 12 });
  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 2, watermark: 21 });
});

test('繋がらないまま閉じても、次の起動で送られる', async ({ page }) => {
  const recorder = await mockApi(page);
  const abort = await cutRead(page);

  await page.goto('/');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');

  // 送信を 1 回試みて失敗するまで待ってから閉じる（debounce は 2 秒）。
  // ここまで来れば、送信待ちは IndexedDB に落ちている
  await page.waitForTimeout(3_000);

  await page.reload();
  // 既読は手元に残っているので、読み終えた続きから出る
  await expect(page.getByTestId('entry-title')).toHaveText('夕刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });
  expect(recorder.readMarks).toEqual([]);

  await restore(page, abort);

  // 前の起動で積まれた分が、そのまま届く（送信は冪等なので二重でも害が無い）
  await expect
    .poll(() => recorder.readMarks, { timeout: SEND_TIMEOUT })
    .toContainEqual({ feedId: 1, watermark: 12 });
});
