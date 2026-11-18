import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { selectEntries } from '../db/entries';
import { appendTranscript, selectTranscript } from '../db/transcripts';
import { getEntryRows, getFeedRow, resetDb, seedEntry, seedFeed } from '../test/seed';
import { TEXT_MODEL } from './choose';
import { crawl } from './index';
import { sectionsOf, summarizeTranscript } from './summarize';
import {
  ASR_MODEL,
  CHUNK_BYTES,
  MAX_FAILURES,
  parseContentRange,
  readTranscription,
  transcribePending,
} from './transcribe';
import podcastXml from './__fixtures__/podcast-rebuild.xml?raw';

/**
 * Podcast の文字起こし（issue #46）。音声のサーバと Workers AI は差し替える。
 * 見るのは「Range で区切って続きから起こす」「最新 3 件だけ」「諦めどころ」「要約の HTML を
 * LLM に書かせない」。
 */

const NOW = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);

/** Range に応じる音声のサーバ。URL ごとに大きさを決める。取りに来た範囲を記録する */
function audioServer(
  sizes: Record<string, number>,
  options: { status?: number; ignoreRange?: boolean; type?: string } = {},
) {
  const ranges: { url: string; range: string | null }[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const range = new Headers(init?.headers).get('range');
    ranges.push({ url, range });
    const size = sizes[url];
    if (size === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (options.status !== undefined) {
      return Promise.resolve(new Response('error', { status: options.status }));
    }
    const type = options.type ?? 'audio/mpeg';
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (options.ignoreRange || match === null) {
      return Promise.resolve(
        new Response(new Uint8Array(size), {
          status: 200,
          headers: { 'content-type': type, 'content-length': String(size) },
        }),
      );
    }
    const from = Number(match[1]);
    if (from >= size) return Promise.resolve(new Response(null, { status: 416 }));
    const to = Math.min(Number(match[2]), size - 1);
    return Promise.resolve(
      new Response(new Uint8Array(to - from + 1), {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(to - from + 1),
          'content-range': `bytes ${from}-${to}/${size}`,
        },
      }),
    );
  };
  return { fetch: impl as unknown as typeof fetch, ranges };
}

interface AsrCall {
  bytes: number;
  prompt: string | undefined;
}

/**
 * 区切りごとに「part<n>」と 2 区間を返す Whisper と、決まった文を返す LLM。
 * 区切りの長さは 300 秒として返す
 */
function stubAi(options: { asrFails?: boolean; summary?: string } = {}) {
  const asr: AsrCall[] = [];
  const text: { system: string; user: string }[] = [];
  const ai = {
    run: (model: string, input: Record<string, unknown>) => {
      if (model === ASR_MODEL) {
        if (options.asrFails) return Promise.reject(new Error('3040: capacity'));
        const audio = input.audio as string;
        asr.push({ bytes: atob(audio).length, prompt: input.initial_prompt as string | undefined });
        const n = asr.length;
        return Promise.resolve({
          text: `part${n}a part${n}b`,
          transcription_info: { duration: 300 },
          segments: [
            { start: 0, end: 150, text: ` part${n}a ` },
            { start: 150, end: 300, text: `part${n}b` },
          ],
        });
      }
      if (model === TEXT_MODEL) {
        const messages = input.messages as { content: string }[];
        text.push({ system: messages[0].content, user: messages[1].content });
        return Promise.resolve({ response: options.summary ?? '話の要約。' });
      }
      return Promise.reject(new Error(`unexpected model ${model}`));
    },
  } as unknown as Ai;
  return { ai, asr, text };
}

/** 取得の済んだフィード（次の取得は先）に、音声付きの記事を入れる */
async function seedPodcast(
  episodes: { url: string; chapters?: string; type?: string }[],
  feed: { transcribe?: number } = {},
): Promise<{ feedId: number; entryIds: number[] }> {
  const feedId = await seedFeed(env.DB, 'https://podcast.example.com/feed', {
    transcribe: feed.transcribe ?? 1,
    nextFetchAt: NOW + 3600,
  });
  const entryIds: number[] = [];
  for (const episode of episodes) {
    entryIds.push(
      await seedEntry(env.DB, feedId, {
        title: `エピソード ${episode.url}`,
        audioUrl: episode.url,
        audioType: episode.type ?? 'audio/mpeg',
        audioDuration: 900,
        audioChapters: episode.chapters ?? null,
      }),
    );
  }
  return { feedId, entryIds };
}

const EP1 = 'https://cdn.example.com/ep1.mp3';

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('文字起こし', () => {
  it('Range で区切って起こし、区切りの長さで時刻をずらして足していく', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: CHUNK_BYTES * 2 + 10 });
    const { ai, asr } = stubAi();

    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai });

    expect(server.ranges.map((call) => call.range)).toEqual([
      `bytes=0-${CHUNK_BYTES - 1}`,
      `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`,
      `bytes=${CHUNK_BYTES * 2}-${CHUNK_BYTES * 3 - 1}`,
    ]);
    expect(asr.map((call) => call.bytes)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 10]);
    // 前の区切りの末尾を文脈として渡す
    expect(asr[0].prompt).toBeUndefined();
    expect(asr[1].prompt).toBe('part1a part1b');

    const transcript = await selectTranscript(env.DB, entryIds[0]);
    expect(transcript?.state).toBe('done');
    expect(transcript?.segments).toEqual([
      { start: 0, text: 'part1a' },
      { start: 150, text: 'part1b' },
      { start: 300, text: 'part2a' },
      { start: 450, text: 'part2b' },
      { start: 600, text: 'part3a' },
      { start: 750, text: 'part3b' },
    ]);
  });

  it('枠で止まった分は次の cron が続きから起こす', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: CHUNK_BYTES + 10 });
    const { ai, asr } = stubAi();

    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai, limit: 1 });
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('running');

    await transcribePending(env, { now: NOW + 300, fetchImpl: server.fetch, ai, limit: 1 });
    expect(server.ranges.at(-1)?.range).toBe(`bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`);
    expect(asr[1].prompt).toBe('part1a part1b');
    const transcript = await selectTranscript(env.DB, entryIds[0]);
    expect(transcript?.state).toBe('done');
    expect(transcript?.segments.map((segment) => segment.start)).toEqual([0, 150, 300, 450]);
  });

  it('要約を記事に添えて配り、差分同期で届け直す', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const { ai } = stubAi();

    await transcribePending(env, { now: NOW, fetchImpl: audioServer({ [EP1]: 100 }).fetch, ai });

    const [entry] = await selectEntries(env.DB, {
      sinceId: 0,
      feedId: null,
      unreadOnly: false,
      limit: 10,
    });
    expect(entry.audio).toMatchObject({ url: EP1, transcript: 'done', duration: 900 });
    expect(entry.audio?.summary).toEqual({
      overview: '話の要約。',
      sections: [{ start: 0, title: null, text: '話の要約。' }],
    });
    const [row] = await getEntryRows(env.DB, (await getFeedRow(env.DB, entry.feedId)).id);
    expect(row.id).toBe(entryIds[0]);
    expect(row.body_updated_at).not.toBeNull();
  });

  it('フィードごとに音声付きの最新 3 件だけを起こす', async () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `https://cdn.example.com/ep${n}.mp3`);
    const { entryIds } = await seedPodcast(urls.map((url) => ({ url })));
    const server = audioServer(Object.fromEntries(urls.map((url) => [url, 10])));

    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai: stubAi().ai });

    // 新しい順に起こす
    expect(server.ranges.map((call) => call.url)).toEqual([urls[4], urls[3], urls[2]]);
    expect(await selectTranscript(env.DB, entryIds[1])).toBeNull();
  });

  it('文字起こしを入れていないフィードは起こさない', async () => {
    await seedPodcast([{ url: EP1 }], { transcribe: 0 });
    const server = audioServer({ [EP1]: 10 });
    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai: stubAi().ai });
    expect(server.ranges).toEqual([]);
  });

  it('音声が 404 なら諦める', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    await transcribePending(env, { now: NOW, fetchImpl: audioServer({}).fetch, ai: stubAi().ai });
    const transcript = await selectTranscript(env.DB, entryIds[0]);
    expect(transcript?.state).toBe('failed');
  });

  it('5xx は数えるだけで、上限まで取り直す', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: 10 }, { status: 503 });
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await transcribePending(env, {
        now: NOW + i * 300,
        fetchImpl: server.fetch,
        ai: stubAi().ai,
      });
    }
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('running');
    await transcribePending(env, { now: NOW + 9999, fetchImpl: server.fetch, ai: stubAi().ai });
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('failed');
  });

  it('Workers AI が使えなければ進めず、他のエピソードにも回らない', async () => {
    const urls = ['https://cdn.example.com/a.mp3', 'https://cdn.example.com/b.mp3'];
    const { entryIds } = await seedPodcast(urls.map((url) => ({ url })));
    const server = audioServer({ [urls[0]]: 10, [urls[1]]: 10 });

    await transcribePending(env, {
      now: NOW,
      fetchImpl: server.fetch,
      ai: stubAi({ asrFails: true }).ai,
    });

    expect(server.ranges).toHaveLength(1);
    const transcript = await selectTranscript(env.DB, entryIds[1]);
    expect(transcript).toMatchObject({ state: 'running', segments: [] });
  });

  it('Range に応じないサーバでも、1 区切りに収まる音声は起こす', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: 100 }, { ignoreRange: true });
    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai: stubAi().ai });
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('done');
  });

  it('Range に応じないサーバの長い音声は、読み込まずに諦める', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: CHUNK_BYTES * 3 }, { ignoreRange: true });
    const { ai, asr } = stubAi();
    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai });
    expect(asr).toEqual([]);
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('failed');
  });

  it('Content-Length の無い 206 でも、区切りより長ければ読み切らずに諦める', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const size = CHUNK_BYTES * 2;
    const fetchImpl = (async () =>
      new Response(new Uint8Array(size), {
        status: 206,
        headers: { 'content-range': `bytes 0-${size - 1}/${size}` },
      })) as unknown as typeof fetch;
    const { ai, asr } = stubAi();
    await transcribePending(env, { now: NOW, fetchImpl, ai });
    expect(asr).toEqual([]);
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('failed');
  });

  it('要約を作れなかったら、音声を取り直さずに次の cron で要約だけやり直す', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const server = audioServer({ [EP1]: 100 }, { ignoreRange: true });
    const failing = {
      run: (model: string, input: Record<string, unknown>) =>
        model === ASR_MODEL
          ? stubAi().ai.run(model as never, input as never)
          : Promise.reject(new Error('down')),
    } as unknown as Ai;

    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai: failing });
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('running');

    await transcribePending(env, { now: NOW + 300, fetchImpl: server.fetch, ai: stubAi().ai });
    expect(server.ranges).toHaveLength(1);
    const transcript = await selectTranscript(env.DB, entryIds[0]);
    expect(transcript?.state).toBe('done');
    expect(transcript?.segments).toHaveLength(2);
  });

  it('MP3 でない長い音声は区切れないので諦める', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1, type: 'audio/x-m4a' }]);
    const server = audioServer({ [EP1]: CHUNK_BYTES + 1 }, { type: 'audio/x-m4a' });
    await transcribePending(env, { now: NOW, fetchImpl: server.fetch, ai: stubAi().ai });
    expect((await selectTranscript(env.DB, entryIds[0]))?.state).toBe('failed');
  });

  it('同じ区切りを 2 度書かない（cron の重なり）', async () => {
    const { entryIds } = await seedPodcast([{ url: EP1 }]);
    const progress = {
      entryId: entryIds[0],
      fromByte: 0,
      nextByte: 10,
      totalBytes: 100,
      tail: '',
      elapsed: 300,
      segments: [{ start: 0, text: 'a' }],
      now: NOW,
    };
    expect(await appendTranscript(env.DB, progress)).toBe(true);
    expect(await appendTranscript(env.DB, progress)).toBe(false);
    expect((await selectTranscript(env.DB, entryIds[0]))?.segments).toHaveLength(1);
  });
});

describe('購読の取り込み', () => {
  it('エピソードの音声を記事に残し、文字起こしを勧める', async () => {
    const feedId = await seedFeed(env.DB, 'https://feeds.rebuild.fm/rebuildfm');
    const fetchImpl = (async () =>
      new Response(podcastXml, {
        headers: { 'content-type': 'application/rss+xml' },
      })) as unknown as typeof fetch;

    await crawl(env, { now: NOW, fetchImpl, ai: stubAi().ai });

    const rows = await getEntryRows(env.DB, feedId);
    expect(rows.map((row) => row.audio_url)).toEqual([
      'https://cache.rebuild.fm/podcast-ep1.mp3',
      'https://cache.rebuild.fm/podcast-ep435.mp3',
    ]);
    expect(rows[1].audio_duration).toBe(9293);
    expect(JSON.parse(rows[1].audio_chapters ?? '[]')).toHaveLength(14);
    expect((await getFeedRow(env.DB, feedId)).transcribe_suggested).toBe(1);
  });
});

describe('音声の列ができる前から購読していた Podcast', () => {
  it('音声付きの記事が初めて届いたとき、取り込み済みの記事にも音声を書き足す', async () => {
    const feedId = await seedFeed(env.DB, 'https://feeds.rebuild.fm/rebuildfm');
    const respond = (body: string) =>
      (async () =>
        new Response(body, {
          headers: { 'content-type': 'application/rss+xml' },
        })) as unknown as typeof fetch;
    // 音声の無い形で一度取り込んだ状態を作る
    const withoutAudio = podcastXml.replace(/<enclosure [^>]*\/>/g, '');
    await crawl(env, { now: NOW, fetchImpl: respond(withoutAudio), ai: stubAi().ai });
    expect((await getEntryRows(env.DB, feedId)).every((row) => row.audio_url === null)).toBe(true);

    await crawl(env, {
      now: NOW + 3600,
      fetchImpl: respond(podcastXml),
      ai: stubAi().ai,
      feedIds: [feedId],
    });
    expect((await getEntryRows(env.DB, feedId)).map((row) => row.audio_url)).toEqual([
      'https://cache.rebuild.fm/podcast-ep1.mp3',
      'https://cache.rebuild.fm/podcast-ep435.mp3',
    ]);
  });
});

describe('要約', () => {
  const segments = [
    { start: 0, text: 'はじめ' },
    { start: 400, text: 'つづき' },
    { start: 700, text: 'おわり' },
  ];

  it('チャプターがあればチャプターごと、無ければ 10 分ごとに区切る', () => {
    expect(sectionsOf(segments, []).map((s) => [s.start, s.text])).toEqual([
      [0, 'はじめ つづき'],
      [600, 'おわり'],
    ]);
    const chapters = [
      { start: 5, title: 'Intro' },
      { start: 300, title: '本題' },
    ];
    expect(sectionsOf(segments, chapters).map((s) => [s.start, s.title, s.text])).toEqual([
      [0, 'Intro', 'はじめ'],
      [300, '本題', 'つづき おわり'],
    ]);
  });

  it('区間ごとの要約と全体の要旨を値で返す（HTML にしない）', async () => {
    const { ai, text } = stubAi({ summary: '<b>要約</b>' });
    const summary = await summarizeTranscript(
      segments,
      { title: 'ep', audioUrl: EP1, chapters: [] },
      ai,
    );
    expect(summary).toEqual({
      overview: '<b>要約</b>',
      sections: [
        { start: 0, title: null, text: '<b>要約</b>' },
        { start: 600, title: null, text: '<b>要約</b>' },
      ],
    });
    // 区間 2 つと全体の要旨 1 つ
    expect(text).toHaveLength(3);
    expect(text[2].user).toContain('[10:00]');
  });

  it('AI が使えなければ null', async () => {
    const ai = { run: () => Promise.reject(new Error('down')) } as unknown as Ai;
    expect(
      await summarizeTranscript(segments, { title: 'ep', audioUrl: EP1, chapters: [] }, ai),
    ).toBeNull();
  });
});

describe('Whisper の応答と Range の読み取り', () => {
  it('区間が無ければ全文を区切りの頭に置く', () => {
    expect(readTranscription({ text: ' hello ' })).toEqual({
      duration: null,
      segments: [{ start: 0, text: 'hello' }],
    });
    expect(readTranscription(null)).toEqual({ duration: null, segments: [] });
  });

  it('Content-Range を読む', () => {
    expect(parseContentRange('bytes 0-4194303/111966273')).toEqual({
      from: 0,
      to: 4194303,
      total: 111966273,
    });
    expect(parseContentRange('bytes 0-1/*')).toBeNull();
    expect(parseContentRange('bytes 5-1/10')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });
});
