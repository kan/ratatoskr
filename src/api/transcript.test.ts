import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EntriesResponse, TranscriptResponse } from '../../shared/types';
import { appendTranscript, completeTranscript, updateCleanedParts } from '../db/transcripts';
import { apiGet, apiJson } from '../test/request';
import { seedEntry, seedFeed } from '../test/seed';

const SUMMARY = { overview: '要旨', sections: [{ start: 0, title: 'Intro', text: '導入' }] };

/** Podcast の文字起こし（issue #46）。全文は記事に載せず、ここから取る */
describe('GET /api/entries/:id/transcript', () => {
  async function seedEpisode(): Promise<{ feedId: number; entryId: number }> {
    const feedId = await seedFeed(env.DB, 'https://t-api.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId, {
      audioUrl: 'https://cdn.example.com/ep.mp3',
      audioType: 'audio/mpeg',
      audioDuration: 600,
      audioChapters: '[{"start":0,"title":"Intro"},{"start":"壊れた","title":"x"}]',
    });
    return { feedId, entryId };
  }

  it('始めていなければ 404', async () => {
    const { entryId } = await seedEpisode();
    expect((await apiGet(`/api/entries/${entryId}/transcript`)).status).toBe(404);
  });

  it('途中でも起こした分を返し、要約は終わるまで返さない', async () => {
    const { feedId, entryId } = await seedEpisode();
    await appendTranscript(env.DB, {
      entryId,
      fromByte: 0,
      nextByte: 10,
      totalBytes: 100,
      tail: '',
      elapsed: 300,
      segments: [{ start: 1.5, text: 'こんにちは\tタブ' }],
      now: 0,
    });

    const body = await apiJson<TranscriptResponse>(`/api/entries/${entryId}/transcript`);
    expect(body).toEqual({
      state: 'running',
      segments: [{ start: 1.5, text: 'こんにちは タブ' }],
      // 清書はまだ
      paragraphs: null,
      summary: null,
    });

    // 記事には状態だけが付き、全文は載らない
    const entries = await apiJson<EntriesResponse>(`/api/entries?feedId=${feedId}`);
    expect(entries.entries[0].audio).toEqual({
      url: 'https://cdn.example.com/ep.mp3',
      type: 'audio/mpeg',
      duration: 600,
      // 形の崩れたチャプターは捨てる
      chapters: [{ start: 0, title: 'Intro' }],
      transcript: 'running',
    });
  });

  it('終われば要約も返し、記事にも添える', async () => {
    const { feedId, entryId } = await seedEpisode();
    await appendTranscript(env.DB, {
      entryId,
      fromByte: 0,
      nextByte: 10,
      totalBytes: 100,
      tail: '',
      elapsed: 300,
      segments: [{ start: 0, text: 'a' }],
      now: 0,
    });
    await updateCleanedParts(env.DB, entryId, [
      { fromByte: 0, paragraphs: [{ start: 0, text: 'A。' }] },
    ]);
    await completeTranscript(env.DB, entryId, SUMMARY, 100);

    const body = await apiJson<TranscriptResponse>(`/api/entries/${entryId}/transcript`);
    expect(body.summary).toEqual(SUMMARY);
    expect(body.segments).toEqual([{ start: 0, text: 'a' }]);
    expect(body.paragraphs).toEqual([{ start: 0, text: 'A。' }]);
    const entries = await apiJson<EntriesResponse>(`/api/entries?feedId=${feedId}`);
    expect(entries.entries[0].audio?.summary).toEqual(SUMMARY);
  });
});
