import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * スマホの操作（M8。docs/UX.md「境界でのボタン変化」「画面構成（スマホ）」）。
 *
 * 見るのは 3 つ。ボトムバーが境界でラベルだけを変えること、左右スワイプが
 * j / k と同じに動くこと、フィード一覧がヘッダから開く引き出しになっていること。
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const title = (page: Page) => page.getByTestId('entry-title');

async function open(page: Page): Promise<void> {
  await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
}

/**
 * 本物の指の動きを作る。Playwright のタッチ操作は tap しか無いので、
 * TouchEvent を組み立てて投げる（アプリ側の判定はそのまま通る）。
 *
 * 指を置く場所は要素の中央。どこから始まったかで扱いが変わる（横スクロールする
 * 入れ物の中は記事送りにしない）ので、始点は要素を名指しして決める。
 */
async function swipe(page: Page, dx: number, dy = 0, testId = 'reader'): Promise<void> {
  await page.evaluate(
    ({ dx, dy, testId }) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (el === null) throw new Error(`${testId} が無い`);

      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + Math.min(box.height / 2, 200);
      const at = (dx: number, dy: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: x + dx, clientY: y + dy });

      const from = at(0, 0);
      el.dispatchEvent(
        new TouchEvent('touchstart', { touches: [from], changedTouches: [from], bubbles: true }),
      );
      el.dispatchEvent(
        new TouchEvent('touchend', { touches: [], changedTouches: [at(dx, dy)], bubbles: true }),
      );
    },
    { dx, dy, testId },
  );
}

/**
 * 下端に着いてから、さらに上へ引く指。
 *
 * 指を離すかどうかを分けてあるのは、引いている最中の知らせ（離すと次の記事へ）も
 * 見るため。始点は毎回同じ計算で出すので、離す側は控えを持たなくてよい。
 */
async function pull(page: Page, dy: number, release = true): Promise<void> {
  await page.evaluate(
    ({ dy, release }) => {
      const el = document.querySelector('[data-testid="reader"]');
      if (el === null) throw new Error('記事ビューが無い');

      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height - 40;
      const at = (dy: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: x, clientY: y + dy });

      if (!release) {
        const from = at(0);
        el.dispatchEvent(
          new TouchEvent('touchstart', { touches: [from], changedTouches: [from], bubbles: true }),
        );
        // 指は一息には動かない。途中の位置でも判定が壊れないことを込みで見る
        for (const step of [dy / 2, dy]) {
          const moved = at(step);
          el.dispatchEvent(
            new TouchEvent('touchmove', {
              touches: [moved],
              changedTouches: [moved],
              bubbles: true,
            }),
          );
        }
        return;
      }
      el.dispatchEvent(
        new TouchEvent('touchend', { touches: [], changedTouches: [at(dy)], bubbles: true }),
      );
    },
    { dy, release },
  );
}

/** 記事ビューを下端まで送る。引きの判定は下端に着いてからしか始まらない */
async function toBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="reader"]');
    if (el === null) throw new Error('記事ビューが無い');
    el.scrollTop = el.scrollHeight;
  });
}

test('狭い画面では記事ビューが既定で、フィード一覧はヘッダから開く', async ({ page }) => {
  await open(page);
  // 一覧は組み立てられてもいない（記事送りのたびの再描画に付き合わせない）
  await expect(page.getByTestId('feed-1')).toHaveCount(0);

  await page.getByTestId('open-feed-list').click();
  await expect(page.getByTestId('feed-1')).toBeVisible();

  // 一覧は移動手段。記事を選んだらそのまま読みに戻る
  await page.getByTestId('feed-2').click();
  await page.getByTestId('entry-21').click();
  await expect(title(page)).toHaveText('夕刊の 1 本目');
  await expect(page.getByTestId('feed-2')).toHaveCount(0);
});

test('引き出しは閉じるボタンでも畳める', async ({ page }) => {
  await open(page);
  await page.getByTestId('open-feed-list').click();
  await page.getByTestId('close-feed-list').click();
  await expect(page.getByTestId('feed-1')).toHaveCount(0);
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('引き出しを開いたまま m を押しても、購読管理が引き出しの裏に隠れない', async ({ page }) => {
  await open(page);
  await page.getByTestId('open-feed-list').click();
  await expect(page.getByTestId('feed-1')).toBeVisible();

  await page.keyboard.press('m');

  await expect(page.getByTestId('subscription-manager')).toBeVisible();
  // 引き出しは不透明で購読管理より手前に出る。畳まないと開いたことに気付けない
  await expect(page.getByTestId('feed-1')).toHaveCount(0);
});

test('ボトムバーは境界でラベルだけが変わる', async ({ page }) => {
  await open(page);
  const next = page.getByTestId('bottom-next');
  const prev = page.getByTestId('bottom-prev');

  // 朝刊の 1 本目。前は先頭、後ろにはまだ記事がある
  await expect(prev).toHaveText('◀ 前のフィード');
  await expect(next).toHaveText('次の記事 ▶');

  await next.click();
  await expect(title(page)).toHaveText('朝刊の 2 本目');
  // 最終記事に来たので、同じ位置のボタンがフィード移動に変わる
  await expect(next).toHaveText('次のフィード ▶');
  await expect(prev).toHaveText('◀ 前の記事');

  await next.click();
  await expect(title(page)).toHaveText('夕刊の 1 本目');
  // 1 件しかないフィードでは、両側ともフィード移動
  await expect(next).toHaveText('次のフィード ▶');
  await expect(prev).toHaveText('◀ 前のフィード');

  await prev.click();
  await expect(title(page)).toHaveText('朝刊の 2 本目');
});

test('左右スワイプで記事を送る', async ({ page }) => {
  await open(page);

  await swipe(page, -120);
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  await swipe(page, 120);
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  // 境界を越えるとフィードを跨ぐ（j / k と同じ経路）
  await swipe(page, -120);
  await swipe(page, -120);
  await expect(title(page)).toHaveText('夕刊の 1 本目');
});

test('縦に流れた指と短い指では記事を送らない', async ({ page }) => {
  await open(page);

  await swipe(page, -120, 140);
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  await swipe(page, -30);
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('横スクロールする入れ物の中から始めた指では記事を送らない', async ({ page }) => {
  await open(page);

  // 表やコード片を横に送るつもりの指で記事が飛ぶと、読み返す手立てが無くなる
  await page.evaluate(() => {
    const body = document.querySelector('.article-body');
    if (body === null) throw new Error('本文が無い');
    const pre = document.createElement('pre');
    pre.dataset.testid = 'wide-block';
    pre.textContent = 'x'.repeat(800);
    body.prepend(pre);
  });

  await swipe(page, -120, 0, 'wide-block');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('ボトムバーからピンを付け外しできる', async ({ page }) => {
  const recorder = await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  const pin = page.getByTestId('bottom-pin');
  await pin.click();
  // 記事は切り替わらない（docs/UX.md）
  await expect(title(page)).toHaveText('朝刊の 1 本目');
  await expect(page.getByTestId('entry-pinned')).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => recorder.pinned.length, { timeout: 15_000 }).toBe(1);

  await pin.click();
  await expect(page.getByTestId('entry-pinned')).toHaveCount(0);
});

test('下端でさらに引くと次の記事へ進む', async ({ page }) => {
  await open(page);
  await toBottom(page);

  // 引いている間は、離したら何が起きるかを出す
  await pull(page, -140, false);
  await expect(page.getByTestId('pull-hint')).toBeVisible();

  await pull(page, -140);
  await expect(title(page)).toHaveText('朝刊の 2 本目');
  await expect(page.getByTestId('pull-hint')).toHaveCount(0);
});

test('浅い引きと、本文が残っている間の引きでは進まない', async ({ page }) => {
  await open(page);
  await toBottom(page);

  // 読み終わりの数行を送るだけの指で飛ばさない
  await pull(page, -40, false);
  await expect(page.getByTestId('pull-hint')).toHaveCount(0);
  await pull(page, -40);
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  // 本文の途中は普通のスクロール
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="reader"]');
    if (el !== null) el.scrollTop = 0;
  });
  await pull(page, -200, false);
  await pull(page, -200);
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});
