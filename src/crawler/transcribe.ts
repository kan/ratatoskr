import type { TranscriptSegment } from '../../shared/types';
import {
  appendTranscript,
  completeTranscript,
  recordTranscriptFailure,
  selectTranscriptionTargets,
  selectTranscriptSegments,
  tailOf,
  type TranscriptionTarget,
} from '../db/transcripts';
import { errorMessage } from '../lib/errors';
import { asArray, asObject, asString } from '../lib/json';
import { describeNetworkError, reserveBudget, TIMEOUT_MS, USER_AGENT } from './fetch';
import { createPoliteFetch } from './polite';
import { summarizeTranscript } from './summarize';

/**
 * Podcast のエピソードを文字起こしする（issue #46）。
 *
 * **音声を Range で区切り、区切りごとに Workers AI の Whisper に渡す。** 2 時間半の
 * エピソードは 100MB を超え、Worker のメモリ（128MB）にもモデルの入力にも 1 度には
 * 載らない。MP3 はフレームの並びなので、バイト数で切っても切れ目のフレームが 1 つ
 * 壊れるだけで、デコーダは次のフレームから読み直す（Cloudflare の公式チュートリアル
 * 「Transcribe large audio files」も同じ切り方をしている）。切れ目にかかった語は崩れる
 * ことがあるが、要約の材料としては足りる。
 *
 * **1 回の cron で終わらせない。** 区切りごとに進み具合（next_byte / elapsed）を D1 に
 * 書くので、次の cron はその続きから起こす。1 回に起こす区切りは枠で絞る
 * （サブリクエスト上限と、cron の CPU 時間のため）。
 *
 * **フィードの取得とは別の仕事として cron から呼ぶ**（src/index.ts）。取得の後ろに
 * ぶら下げると、更新の少ない番組は取得間隔が数時間に延びるので、1 本を起こし終えるのに
 * 何日もかかる。手動の更新（POST /api/feeds/:id/fetch）からは呼ばない（区切りごとに
 * Workers AI を待つので、応答が分単位で遅れる）。
 *
 * 起こし終えたら要約を作る（src/crawler/summarize.ts）。全文は記事に載せず、要約だけを
 * 記事に添えて配る。
 */

export const ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * 区切り 1 つの大きさ。96kbps の MP3（Rebuild）で約 5 分半。
 *
 * 大きいほど 1 本に要る要求の数が減るが、Base64 にして 1 度に渡すので、メモリと
 * 1 要求の大きさに効く。Workers AI はモデルの入力の上限を明記していないので、
 * 公式チュートリアル（1MB）より大きく、メモリには十分に余裕のある値にした
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** 音声付きの記事のうち、フィードごとに文字起こしする最新の件数（履歴の長い番組の過去回を起こさない） */
export const LATEST_EPISODES = 3;

/**
 * 続けて何回失敗したら諦めるか。5 分毎の cron で 1 時間ぶん。
 *
 * Workers AI の障害も数える。数えないと、決まって失敗する区切り（壊れた音声など）で
 * 毎回枠を使い切り、後ろのエピソードが進まない。成功すれば 0 に戻る
 */
export const MAX_FAILURES = 12;

/** 音声の取得の打ち切り。区切り 1 つ（4MB）を読み切るまで */
const AUDIO_TIMEOUT_MS = TIMEOUT_MS * 4;

/**
 * 1 回の cron で文字起こしする音声の区切りの数。
 *
 * 区切り 1 つで音声の取得 1 回と Workers AI 1 回。96kbps の MP3 で約 5 分半ずつなので、
 * 2 時間半のエピソードが 4 回の cron（20 分）で起こし終わる
 */
const MAX_CHUNKS_PER_RUN = 8;

export interface TranscribeOptions {
  now?: number;
  /** テストで差し替える */
  fetchImpl?: typeof fetch;
  ai?: Ai;
  /** 起こせる区切りの数。既定は MAX_CHUNKS_PER_RUN */
  limit?: number;
}

interface Context {
  db: D1Database;
  ai: Ai;
  fetchImpl: typeof fetch;
  /** 起こせる区切りの残り。エピソードをまたいで減っていく */
  budget: { remaining: number };
  now: number;
}

/**
 * 文字起こしを進める（cron から）。
 *
 * @returns 要約まで済んだ記事の id
 */
export async function transcribePending(
  env: Env,
  options: TranscribeOptions = {},
): Promise<number[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const limit = options.limit ?? MAX_CHUNKS_PER_RUN;
  // 区切りの数より多くのエピソードは 1 回では進められない
  const targets = await selectTranscriptionTargets(env.DB, LATEST_EPISODES, limit);
  // **仕事が無ければ env.AI に触らない。** 触るだけでリモートへの接続が要る
  if (targets.length === 0) return [];
  const ai = options.ai ?? env.AI;

  // 外向きの要求の行儀（同じホストへは 1 本ずつ・流量の制限を受けたら出さない）は
  // フィードの取得と同じ包みで守る（issue #39）
  const polite = createPoliteFetch(options.fetchImpl ?? fetch, { db: env.DB, now });
  const context: Context = {
    db: env.DB,
    ai,
    fetchImpl: polite.fetch,
    budget: { remaining: limit },
    now,
  };

  const completed: number[] = [];
  // **1 本ずつ順に進める。** 区切りは前の区切りの末尾を文脈として Whisper に渡すので、
  // 同じエピソードの中は並べられない。新しいエピソードから起こす
  for (const target of targets) {
    if (context.budget.remaining <= 0) break;
    const outcome = await transcribeEpisode(target, context);
    if (outcome === 'finished' && (await summarize(target, context))) {
      completed.push(target.entryId);
    }
    // Workers AI が使えないなら、他のエピソードを回しても同じ
    if (outcome === 'unavailable') break;
  }
  return completed;
}

/** pending は「この回はここまで」（枠切れ・失敗を数えた・別の実行が先に進めていた） */
type EpisodeOutcome = 'finished' | 'pending' | 'unavailable';

/** 失敗を数える。続けて MAX_FAILURES 回、または giveUp なら諦める */
function recordFailure(
  context: Context,
  entryId: number,
  message: string,
  giveUp: boolean,
): Promise<void> {
  return recordTranscriptFailure(context.db, {
    entryId,
    message,
    giveUp,
    maxFailures: MAX_FAILURES,
    now: context.now,
  });
}

async function transcribeEpisode(
  target: TranscriptionTarget,
  context: Context,
): Promise<EpisodeOutcome> {
  let { nextByte, elapsed, tail } = target;

  for (;;) {
    // 起こし終えて要約だけが残っている（前の回に要約を作れなかった）。音声は取りに行かない
    if (target.totalBytes !== null && nextByte >= target.totalBytes) return 'finished';
    if (reserveBudget(context.budget, 1) === 0) return 'pending';

    const chunk = await fetchChunk(target, nextByte, context.fetchImpl);
    if (chunk.kind === 'error') {
      await recordFailure(context, target.entryId, chunk.message, chunk.permanent);
      return 'pending';
    }
    // 音声の本体は Workers AI に渡したら手放す（区切りの大きさだけを控える）
    const size = chunk.bytes.byteLength;

    let result: Transcription;
    try {
      result = readTranscription(
        await context.ai.run(ASR_MODEL, {
          audio: chunk.bytes.toBase64(),
          // 前の区切りの末尾を見せる。区切りの頭で、話の続きとして読ませる
          ...(tail === '' ? {} : { initial_prompt: tail }),
        }),
      );
    } catch (err) {
      console.warn('文字起こしに失敗', target.audioUrl, errorMessage(err));
      await recordFailure(context, target.entryId, `Workers AI: ${errorMessage(err)}`, false);
      return 'unavailable';
    }

    const duration = result.duration ?? estimateDuration(size, chunk.total, target.audioDuration);
    const segments = result.segments.map((segment) => ({
      start: elapsed + segment.start,
      text: segment.text,
    }));
    if (segments.length > 0) tail = tailOf(segments);
    const written = await appendTranscript(context.db, {
      entryId: target.entryId,
      fromByte: nextByte,
      nextByte: nextByte + size,
      totalBytes: chunk.total,
      elapsed: elapsed + duration,
      segments,
      tail,
      now: context.now,
    });
    // 別の実行が先に進めていた（cron の重なり）。続きはそちらに任せる
    if (!written) return 'pending';

    nextByte += size;
    elapsed += duration;
    if (nextByte >= chunk.total) return 'finished';
  }
}

type Chunk =
  | { kind: 'bytes'; bytes: Uint8Array; total: number }
  | { kind: 'error'; message: string; permanent: boolean };

/**
 * 区切り 1 つを Range で取る。
 *
 * - 206 … 区切り。全体の大きさは Content-Range から（控えて、末尾に届いたら取りに行かない）
 * - 200 … Range を受け付けないサーバ。全体が 1 区切りに収まるときだけ使う
 * - 区切りが要る長さで MP3 でない音声（AAC の m4a など）は諦める。m4a は頭か末尾の
 *   目次（moov）が無いと読めないので、バイト数で切れない
 * - 4xx は諦める。5xx と通信の失敗は次の cron で取り直す
 */
async function fetchChunk(
  target: TranscriptionTarget,
  from: number,
  fetchImpl: typeof fetch,
): Promise<Chunk> {
  let response: Response;
  try {
    response = await fetchImpl(target.audioUrl, {
      headers: { 'user-agent': USER_AGENT, range: `bytes=${from}-${from + CHUNK_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
    });
  } catch (err) {
    const { message } = describeNetworkError(err, AUDIO_TIMEOUT_MS);
    return { kind: 'error', message: `音声を取れない: ${message}`, permanent: false };
  }

  // 本文を読まずに断るときは、必ず流れを閉じる
  const reject = async (message: string, permanent: boolean): Promise<Chunk> => {
    await response.body?.cancel();
    return { kind: 'error', message, permanent };
  };

  if (!response.ok) {
    // 429 は流量の制限。待てば取れる
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    return reject(`音声を取れない: HTTP ${response.status}`, permanent);
  }

  // **大きさは Content-Range（206）か Content-Length（200）で確かめ、読む量も区切りで
  // 打ち切る。** 幅を守らずに末尾までを返すサーバを読み切ると、Worker のメモリに載らない
  let total: number;
  /** この応答の本文の大きさ */
  let size: number;
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'));
    if (range === null || range.from !== from || range.to - range.from + 1 > CHUNK_BYTES) {
      return reject('音声のサーバが Range の幅を守らない', true);
    }
    total = range.total;
    size = range.to - range.from + 1;
  } else {
    total = Number(response.headers.get('content-length') ?? NaN);
    if (from > 0 || !Number.isFinite(total) || total > CHUNK_BYTES) {
      return reject('音声のサーバが Range に応じない', true);
    }
    size = total;
  }
  if (total > CHUNK_BYTES && !isMp3(target.audioType ?? response.headers.get('content-type'))) {
    return reject('MP3 でない長い音声は区切れない', true);
  }

  try {
    const bytes = await readExactly(response, size);
    if (bytes === null) {
      return { kind: 'error', message: '音声のサーバが Range の幅を守らない', permanent: true };
    }
    return { kind: 'bytes', bytes, total };
  } catch (err) {
    const { message } = describeNetworkError(err, AUDIO_TIMEOUT_MS);
    return { kind: 'error', message: `音声を取れない: ${message}`, permanent: false };
  }
}

/**
 * ヘッダで確かめた大きさの本文を、先に確保した 1 つの配列へ読み込む（区切りごとに
 * 4MB を 2 度持たない）。食い違えば読むのをやめて null（ヘッダが嘘をついていた）
 */
async function readExactly(response: Response, size: number): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(size);
  if (response.body === null) return size === 0 ? bytes : null;
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > size) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return offset === size ? bytes : null;
}

/** `bytes 0-4194303/111966273`。全体が `*`（分からない）や壊れた値なら null */
export function parseContentRange(
  header: string | null,
): { from: number; to: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)\s*$/.exec(header?.trim() ?? '');
  if (match === null) return null;
  const [from, to, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return to >= from && total > to ? { from, to, total } : null;
}

function isMp3(type: string | null): boolean {
  return /^audio\/(mpeg|mp3|mpeg3|x-mpeg|x-mp3)\b/i.test(type ?? '');
}

interface Transcription {
  /** 区切りの長さ（秒）。応答に無ければ null */
  duration: number | null;
  segments: TranscriptSegment[];
}

/** Whisper の応答を読む。区間（segments）が無ければ全文を区切りの頭に置く */
export function readTranscription(result: unknown): Transcription {
  const object = asObject(result);
  const info = asObject(object?.transcription_info);
  const duration = typeof info?.duration === 'number' && info.duration > 0 ? info.duration : null;

  const segments = asArray(object?.segments).flatMap((value) => {
    const segment = asObject(value);
    const text = asString(segment?.text)?.trim() ?? '';
    const start = segment?.start;
    return text !== '' && typeof start === 'number' ? [{ start, text }] : [];
  });
  if (segments.length > 0) return { duration, segments };

  const text = asString(object?.text)?.trim() ?? '';
  return { duration, segments: text === '' ? [] : [{ start: 0, text }] };
}

/**
 * 応答に長さが無かったときの目安。全体の長さが分かっていればバイト数で按分する
 * （固定ビットレートなら正確で、可変でも次の区切りの時刻がずれるだけ）
 */
function estimateDuration(bytes: number, total: number, duration: number | null): number {
  return duration === null ? 0 : (duration * bytes) / total;
}

async function summarize(target: TranscriptionTarget, context: Context): Promise<boolean> {
  const segments = await selectTranscriptSegments(context.db, target.entryId);
  const summary = await summarizeTranscript(segments, target, context.ai);
  // 要約できなかった。起こし終えた状態（running で末尾まで）のまま次の cron に回し、
  // 要約からやり直す。失敗は数えて、決まって失敗するエピソードで毎回 AI を呼び続けない
  // ようにする（文字起こしは残る）
  if (summary === null) {
    await recordFailure(context, target.entryId, '要約を作れない', false);
    return false;
  }
  await completeTranscript(context.db, target.entryId, summary, context.now);
  return true;
}

// Uint8Array.prototype.toBase64（workerd は実装済み。TypeScript 5.9 の lib にはまだ無い）
declare global {
  interface Uint8Array {
    toBase64(): string;
  }
}
