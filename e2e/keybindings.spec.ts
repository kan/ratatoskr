import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './fixtures';

/**
 * キーバインドが仕様どおりに動くことの確認（docs/UX.md）。
 * UI のテストはここに寄せる方針（CLAUDE.md のテスト方針）。
 */

const title = (page: Page) => page.getByTestId('entry-title');
const position = (page: Page) => page.getByTestId('position');

async function open(page: Page): Promise<void> {
  await mockApi(page);
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
}

test('j で次の記事、k で前の記事に移る', async ({ page }) => {
  await open(page);
  await expect(position(page)).toContainText('(1/2) 朝刊');

  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('朝刊の 2 本目');
  await expect(position(page)).toContainText('(2/2) 朝刊');

  await page.keyboard.press('k');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('最終記事で j を押すと次のフィードに移る', async ({ page }) => {
  await open(page);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('夕刊の 1 本目');
  await expect(position(page)).toContainText('(1/1) 夕刊');
});

test('s で次のフィード、a で前のフィードに移る', async ({ page }) => {
  await open(page);
  await page.keyboard.press('s');
  await expect(title(page)).toHaveText('夕刊の 1 本目');

  // 戻ると、既に表示した 1 本目は飛ばして続きから出る
  await page.keyboard.press('a');
  await expect(title(page)).toHaveText('朝刊の 2 本目');
});

test('未読が無いフィードは s で飛ばす', async ({ page }) => {
  await open(page);
  await page.keyboard.press('s');
  await expect(title(page)).toHaveText('夕刊の 1 本目');

  // ★1「既読済み」は一覧には出るが、移動先にはならない
  await expect(page.getByTestId('feed-3')).toBeVisible();
  await page.keyboard.press('s');
  await expect(page.getByTestId('finished')).toHaveText('全て読み終えた');
});

test('Space は下端まではスクロールし、下端で次の記事へ進む', async ({ page }) => {
  await open(page);
  const scrollTop = () => page.getByTestId('reader').evaluate((el) => el.scrollTop);

  expect(await scrollTop()).toBe(0);
  await page.keyboard.press('Space');
  expect(await scrollTop()).toBeGreaterThan(0);
  // 1 回では下端に着かない長さの本文なので、まだ同じ記事のまま
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  // 下端まで送ってから、もう一度押すと記事が変わる
  await page.getByTestId('reader').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.keyboard.press('Space');
  await expect(title(page)).toHaveText('朝刊の 2 本目');
});

test('Shift+Space は先頭で前の記事の末尾に戻る', async ({ page }) => {
  await open(page);
  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  await page.keyboard.press('Shift+Space');
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  // 末尾に着地するので、そのまま読み返せる（先頭に着地すると更に前へ飛んでしまう）
  const reader = page.getByTestId('reader');
  await expect
    .poll(() => reader.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
    .toBe(true);
});

test('全て読み終えるとその旨を表示して止まる', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('j');
  await expect(page.getByTestId('finished')).toBeVisible();

  // そこから先に進まない（先頭に戻って既読の記事を回らない）
  await page.keyboard.press('j');
  await expect(page.getByTestId('finished')).toBeVisible();
});

test('読むそばから未読数が減る', async ({ page }) => {
  await open(page);
  // 1 本目を開いた時点でその記事は既読になっている
  await expect(page.getByTestId('feed-1')).toContainText('(1)');

  await page.keyboard.press('j');
  await expect(page.getByTestId('feed-1')).not.toContainText('(1)');
});

test('Shift+S でフィードを全て既読にして次へ進む', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('feed-1')).toContainText('(1)');

  await page.keyboard.press('Shift+S');
  await expect(title(page)).toHaveText('夕刊の 1 本目');
  await expect(page.getByTestId('feed-1')).not.toContainText('(');
});

test('左ペインのフィード名で記事一覧を開閉する', async ({ page }) => {
  await open(page);

  // 読んでいる最中のフィードは開いた状態で始まる
  await expect(page.getByTestId('entry-list-1')).toBeVisible();
  await expect(page.getByTestId('entry-list-2')).toBeHidden();

  // 読んでいるフィードも畳める。ただしカーソルが動いたら開き直す
  // （記事を送っている最中に一覧が消えると現在地を見失う）
  await page.getByTestId('feed-1').click();
  await expect(page.getByTestId('entry-list-1')).toBeHidden();
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-list-1')).toBeVisible();
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  // 別のフィードを開いても読んでいる記事は変わらない（移動ではなく開閉）
  await page.getByTestId('feed-2').click();
  await expect(page.getByTestId('entry-list-2')).toBeVisible();
  await expect(title(page)).toHaveText('朝刊の 2 本目');

  // 開いた一覧から記事を選ぶと、そのフィードへ移る
  await page.getByTestId('entry-21').click();
  await expect(title(page)).toHaveText('夕刊の 1 本目');

  // 畳んでから離れたら、開いたままにはしない
  await page.getByTestId('feed-2').click();
  await expect(page.getByTestId('entry-list-2')).toBeHidden();
  await page.keyboard.press('a');
  await expect(page.getByTestId('entry-list-2')).toBeHidden();
});

test('? でヘルプが開き、Esc で閉じる', async ({ page }) => {
  await open(page);
  await page.keyboard.press('?');

  const help = page.getByTestId('help-overlay');
  await expect(help).toBeVisible();
  // keymap.ts から自動生成されている
  await expect(help).toContainText('次の記事');
  await expect(help).toContainText('スクロール、下端で次の記事、最終記事で次のフィード');

  // オーバーレイを開いている間は記事送りが効かない
  await page.keyboard.press('j');
  await expect(help).toBeVisible();

  // 出どころへの導線もここに置く（issue #8）
  await expect(page.getByTestId('help-repository-link')).toHaveAttribute(
    'href',
    'https://github.com/kan/ratatoskr',
  );

  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('m で購読管理が開く', async ({ page }) => {
  await open(page);
  await page.keyboard.press('m');

  await expect(page.getByTestId('subscription-manager')).toBeVisible();
  // キーの一覧にも出る（keymap.ts から自動生成される）
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-overlay')).toContainText('購読管理を開く');
});

test('ヘルプを開いたまま m を押すと、Esc を挟まずに購読管理へ移る', async ({ page }) => {
  // 初回起動ではヘルプが自動で開く。そこに載っているキーが 1 打で効かないと嘘になる
  await open(page);
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-overlay')).toBeVisible();

  await page.keyboard.press('m');

  await expect(page.getByTestId('subscription-manager')).toBeVisible();
  await expect(page.getByTestId('help-overlay')).toBeHidden();
  // 戻る側も同じ。開き直しではなく切り替えになる
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-overlay')).toBeVisible();
  await expect(page.getByTestId('subscription-manager')).toBeHidden();
});

test('Shift+X で読んでいるフィードの購読を解除する', async ({ page }) => {
  const recorder = await mockApi(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  await page.keyboard.press('X');

  await expect.poll(() => recorder.deleted).toEqual([1]);
  // カーソルは次の未読フィードへ移り、読み続けられる
  await expect(title(page)).toHaveText('夕刊の 1 本目');
});

test('Shift+X の確認を断れば何も起きない', async ({ page }) => {
  // 購読を消すと既読位置も設定も失われる。取り消せないので必ず確認を挟む
  const recorder = await mockApi(page);
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.goto('/');
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  await page.keyboard.press('X');
  await page.waitForTimeout(200);

  expect(recorder.deleted).toEqual([]);
  await expect(title(page)).toHaveText('朝刊の 1 本目');
});

test('初回起動時はヘルプを自動で開く', async ({ page }) => {
  await mockApi(page, { showHelp: true });
  await page.goto('/');
  await expect(page.getByTestId('help-overlay')).toBeVisible();

  // 一度閉じれば次からは出ない
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('help-overlay')).toBeHidden();
});

test('入力欄にフォーカスがある間はキーバインドを無効化する', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'probe';
    document.body.append(input);
    input.focus();
  });

  await page.keyboard.press('j');
  await expect(title(page)).toHaveText('朝刊の 1 本目');
  await expect(page.locator('#probe')).toHaveValue('j');
});

test('読んでいるフィードの記事が左ペインに並び、クリックで飛べる', async ({ page }) => {
  await open(page);
  const list = page.getByTestId('entry-list-1');
  await expect(list).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(2);

  // 移動するとカーソルが追随する
  await expect(page.getByTestId('entry-11')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-12')).toHaveAttribute('data-active', 'true');

  // 一覧から直接飛べる
  await page.getByTestId('entry-11').click();
  await expect(title(page)).toHaveText('朝刊の 1 本目');

  // 読んだ記事には既読の印が付く（表示を暗くするため）
  await page.keyboard.press('j');
  await expect(page.getByTestId('entry-11')).toHaveAttribute('data-read', 'true');
  await expect(page.getByTestId('entry-12')).toHaveAttribute('data-read', 'true');

  // 別のフィードに移ると、そちらの記事に入れ替わる（手で開いたものではないので畳まれる）
  await page.keyboard.press('s');
  await expect(page.getByTestId('entry-21')).toBeVisible();
  await expect(page.getByTestId('entry-11')).toBeHidden();
});
