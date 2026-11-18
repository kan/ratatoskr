import { expect, test, type Page } from '@playwright/test';
import type { EntryAudio, TranscriptResponse } from '../shared/types';
import { BOOT_TIMEOUT, mockApi, openApp } from './fixtures';

/**
 * Podcast のエピソード（issue #46）。見るのは、再生器と要約が本文の上に出ること、
 * 要約の目次の時刻で再生位置が動くこと、文字起こしは開いたときに
 * だけ取りに行くこと、記事を送れば再生器が消えること。
 */

const AUDIO_URL = 'https://audio.example.com/ep1.mp3';

const AUDIO: EntryAudio = {
  url: AUDIO_URL,
  type: 'audio/mpeg',
  duration: 9293,
  chapters: [
    { start: 0, title: 'Intro' },
    { start: 332, title: 'HomeView' },
  ],
  transcript: 'done',
  summary: {
    overview: '全体の要約。',
    sections: [
      { start: 0, title: 'Intro', text: '導入。' },
      { start: 332, title: 'HomeView', text: '新製品の話。' },
    ],
  },
};

const TRANSCRIPT: TranscriptResponse = {
  state: 'done',
  segments: [
    { start: 0, text: 'こんにちは' },
    { start: 3725, text: 'ここは 1 時間を過ぎたところ' },
  ],
  summary: AUDIO.summary ?? null,
};

const audioElement = (page: Page) => page.getByTestId('podcast-audio');

async function open(page: Page, audio: EntryAudio = AUDIO) {
  await mockApi(page, { audio: { 11: audio }, bodies: { 11: '<p>ショーノート</p>' } });
  const transcriptCalls: string[] = [];
  await page.route('**/api/entries/*/transcript', async (route) => {
    transcriptCalls.push(route.request().url());
    await route.fulfill({ json: TRANSCRIPT });
  });
  // 音声そのものは取りに行かせない（preload="none" なので、再生しない限り来ない）
  await page.route('https://audio.example.com/**', (route) => route.abort());
  await openApp(page);
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 1 本目', {
    timeout: BOOT_TIMEOUT,
  });
  return { transcriptCalls };
}

test('再生器と要約を本文の上に出し、目次の時刻で再生位置を動かす', async ({ page }) => {
  await open(page);
  await expect(audioElement(page)).toHaveAttribute('src', AUDIO_URL);
  await expect(audioElement(page)).toHaveAttribute('preload', 'none');
  const summary = page.getByTestId('podcast-summary');
  await expect(summary).toContainText('全体の要約。');
  await expect(summary).toContainText('HomeView 新製品の話。');

  await summary.getByRole('button', { name: '5:32' }).click();
  await expect
    .poll(() => audioElement(page).evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBe(332);
});

test('文字起こしは開いたときにだけ取りに行き、時刻で再生位置を動かす', async ({ page }) => {
  const { transcriptCalls } = await open(page);
  expect(transcriptCalls).toEqual([]);

  await page.getByTestId('podcast-transcript-toggle').click();
  const transcript = page.getByTestId('podcast-transcript');
  await expect(transcript).toContainText('こんにちは');
  expect(transcriptCalls).toHaveLength(1);
  expect(transcriptCalls[0]).toMatch(/\/api\/entries\/11\/transcript$/);

  await transcript.getByRole('button', { name: '1:02:05' }).click();
  await expect
    .poll(() => audioElement(page).evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBe(3725);

  await page.getByTestId('podcast-transcript-toggle').click();
  await expect(transcript).toHaveCount(0);
});

test('要約がまだ無ければチャプターを目次にし、文字起こし中と出す', async ({ page }) => {
  await open(page, { ...AUDIO, transcript: 'running', summary: undefined });
  await expect(page.getByTestId('podcast-state')).toHaveText('/ 文字起こし中');
  await expect(page.getByTestId('podcast-contents')).toContainText('HomeView');
  await expect(page.getByTestId('podcast-summary')).not.toContainText('新製品の話。');
});

test('目次を押した後も、Space は記事を送る', async ({ page }) => {
  await open(page);
  await page.getByTestId('podcast-summary').getByRole('button', { name: '0:00' }).click();
  // 本文は短いので、Space 1 回で次の記事へ進む
  await page.keyboard.press(' ');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
  // 記事を送れば再生器は消える（再生も止まる）
  await expect(audioElement(page)).toHaveCount(0);
});

test('再生器にフォーカスがあっても、Space は記事を送る', async ({ page }) => {
  await open(page);
  await audioElement(page).focus();
  await page.keyboard.press(' ');
  await expect(page.getByTestId('entry-title')).toHaveText('朝刊の 2 本目');
});
