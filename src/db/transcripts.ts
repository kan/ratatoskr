import type {
  AudioChapter,
  TranscriptResponse,
  TranscriptSegment,
  TranscriptSummary,
} from '../../shared/types';
import { isTranscriptState } from '../../shared/types';
import { parseChapters, parseSummary } from './audio';

/**
 * Podcast の文字起こし（issue #46。migrations/0012_podcast.sql）。
 * SQL は src/db/ の外に書かない（CLAUDE.md）。
 *
 * 記事に添えて配るもの（状態と要約）は entries に、作業中の状態は transcripts に、
 * 文字起こしの本体は transcript_parts に持つ。
 */

/** 区切りをまたいで Whisper に見せる文字起こしの末尾の長さ（文字数） */
const TAIL_CHARS = 200;

/** 次の区切りの文脈として Whisper に渡す、文字起こしの末尾 */
export function tailOf(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .join(' ')
    .slice(-TAIL_CHARS);
}

/** 文字起こしを進めるエピソード */
export interface TranscriptionTarget {
  entryId: number;
  title: string;
  audioUrl: string;
  audioType: string | null;
  /** 秒。分からなければ null */
  audioDuration: number | null;
  chapters: AudioChapter[];
  /** 次に取りに行く音声の先頭のバイト位置。始めていなければ 0 */
  nextByte: number;
  /** 音声全体の大きさ。最初の区切りを取るまでは null */
  totalBytes: number | null;
  /** ここまでに文字起こしした音声の長さ（秒） */
  elapsed: number;
  tail: string;
}

interface TargetRow {
  entry_id: number;
  title: string;
  audio_url: string;
  audio_type: string | null;
  audio_duration: number | null;
  audio_chapters: string | null;
  next_byte: number | null;
  total_bytes: number | null;
  elapsed: number | null;
  tail: string | null;
}

/**
 * 文字起こしを進めるエピソードを、新しい順に返す。
 *
 * **フィードごとに、音声付きの最新 `perFeed` 件だけを対象にする。** 履歴の長い番組
 * （Rebuild は 500 回を超える）を購読して文字起こしを入れたときに、過去回を全て
 * 起こし始めないため。新しい回が届けば窓が進み、古い回は途中でも置いていく。
 * 窓はフィードごとに (feed_id, id) の索引を新しい側から `perFeed` 件だけ引く。
 *
 * 既読かどうかは見ない。翻訳と違い、1 本に何回かの cron を要するので、読み流した後に
 * 要約が届くことがある。それでも後から開いて要約を読めるようにする。
 */
export async function selectTranscriptionTargets(
  db: D1Database,
  perFeed: number,
  limit: number,
): Promise<TranscriptionTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS entry_id, e.title, e.audio_url, e.audio_type, e.audio_duration,
              e.audio_chapters, t.next_byte, t.total_bytes, t.elapsed, t.tail
         FROM feeds f
         JOIN entries e ON e.id IN (
                SELECT id FROM entries
                 WHERE feed_id = f.id AND audio_url IS NOT NULL
                 ORDER BY id DESC LIMIT ?1)
         LEFT JOIN transcripts t ON t.entry_id = e.id
        WHERE f.transcribe = 1 AND f.disabled = 0
          AND (e.transcript_state IS NULL OR e.transcript_state = 'running')
        ORDER BY e.id DESC
        LIMIT ?2`,
    )
    .bind(perFeed, limit)
    .all<TargetRow>();

  return results.map((row) => ({
    entryId: row.entry_id,
    title: row.title,
    audioUrl: row.audio_url,
    audioType: row.audio_type,
    audioDuration: row.audio_duration,
    chapters: parseChapters(row.audio_chapters),
    nextByte: row.next_byte ?? 0,
    totalBytes: row.total_bytes,
    elapsed: row.elapsed ?? 0,
    tail: row.tail ?? '',
  }));
}

export interface TranscriptProgress {
  entryId: number;
  /** この区切りを取りに行った位置。書き込みの時点で next_byte がこれと一致することを確かめる */
  fromByte: number;
  nextByte: number;
  totalBytes: number;
  elapsed: number;
  /** この区切りで起こした区間 */
  segments: TranscriptSegment[];
  tail: string;
  now: number;
}

/**
 * 区切り 1 つ分の文字起こしを足し、進み具合を進める（1 つの batch）。
 *
 * **cron の実行が 5 分を超えて次の実行と重なると、同じ区切りを 2 回起こすことがある。**
 * 本体は (entry_id, from_byte) の主キーで 1 度しか入らず、進み具合は取りに行った位置が
 * 今の next_byte と一致するときだけ進めるので、二重にならない。
 *
 * @returns 進み具合を進めたか（false なら、別の実行が先に進めていた）
 */
export async function appendTranscript(
  db: D1Database,
  progress: TranscriptProgress,
): Promise<boolean> {
  const [, advanced] = await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO transcript_parts (entry_id, from_byte, segments) VALUES (?, ?, ?)',
      )
      .bind(progress.entryId, progress.fromByte, formatSegments(progress.segments)),
    // 最初の区切りは行を作る。失敗を数えた行（next_byte = 0）が先にあることもある
    db
      .prepare(
        `INSERT INTO transcripts (entry_id, next_byte, total_bytes, elapsed, tail, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (entry_id) DO UPDATE
            SET next_byte = excluded.next_byte,
                total_bytes = excluded.total_bytes,
                elapsed = excluded.elapsed,
                tail = excluded.tail,
                failures = 0,
                updated_at = excluded.updated_at
          WHERE transcripts.next_byte = ?7`,
      )
      .bind(
        progress.entryId,
        progress.nextByte,
        progress.totalBytes,
        progress.elapsed,
        progress.tail,
        progress.now,
        progress.fromByte,
      ),
    db
      .prepare(
        `UPDATE entries SET transcript_state = 'running'
          WHERE id = ? AND transcript_state IS NULL`,
      )
      .bind(progress.entryId),
  ]);
  return (advanced.meta.changes ?? 0) > 0;
}

/**
 * 失敗を数える。`giveUp` なら、あるいは続けて `maxFailures` 回失敗したら諦める
 * （記事の transcript_state を failed に）。始める前（行が無い）でも記録できるように、
 * 行を作ってから数える
 */
export async function recordTranscriptFailure(
  db: D1Database,
  failure: { entryId: number; message: string; giveUp: boolean; maxFailures: number; now: number },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO transcripts (entry_id, failures, error, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (entry_id) DO UPDATE
            SET failures = transcripts.failures + 1,
                error = excluded.error,
                updated_at = excluded.updated_at`,
      )
      .bind(failure.entryId, failure.message, failure.now),
    db
      .prepare(
        `UPDATE entries
            SET transcript_state = CASE
                  WHEN ?2 OR (SELECT failures FROM transcripts WHERE entry_id = ?1) >= ?3
                  THEN 'failed' ELSE 'running' END
          WHERE id = ?1 AND (transcript_state IS NULL OR transcript_state = 'running')`,
      )
      .bind(failure.entryId, failure.giveUp ? 1 : 0, failure.maxFailures),
  ]);
}

/**
 * 要約を書いて終える。body_updated_at を刻んで、まだ読んでいない端末には差分同期で
 * 要約を届ける（migrations/0007）
 */
export async function completeTranscript(
  db: D1Database,
  entryId: number,
  summary: TranscriptSummary,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE entries
          SET transcript_state = 'done', transcript_summary = ?, body_updated_at = ?
        WHERE id = ? AND transcript_state = 'running'`,
    )
    .bind(JSON.stringify(summary), now, entryId)
    .run();
}

/**
 * そのフィードの諦めた文字起こしをやり直させる文（文字起こしを入れ直したとき。
 * src/db/feeds.ts の updateFeedSettings）。起こした分は残して続きから。
 * 失敗の数を先に 0 に戻す（戻さないと次の 1 回の失敗でまた諦める）。バインドは feed_id
 */
export const RESET_TRANSCRIPT_FAILURES = `UPDATE transcripts SET failures = 0
  WHERE entry_id IN (SELECT id FROM entries WHERE feed_id = ? AND transcript_state = 'failed')`;

export const RETRY_FAILED_TRANSCRIPTS = `UPDATE entries SET transcript_state = 'running'
  WHERE feed_id = ? AND transcript_state = 'failed'`;

/** 文字起こしの全文（起こした分）。区切りの順に繋ぐ */
export async function selectTranscriptSegments(
  db: D1Database,
  entryId: number,
): Promise<TranscriptSegment[]> {
  const { results } = await db
    .prepare('SELECT segments FROM transcript_parts WHERE entry_id = ? ORDER BY from_byte')
    .bind(entryId)
    .all<{ segments: string }>();
  return results.flatMap((row) => parseSegments(row.segments));
}

/** GET /api/entries/:id/transcript。文字起こしを始めていなければ null */
export async function selectTranscript(
  db: D1Database,
  entryId: number,
): Promise<TranscriptResponse | null> {
  const row = await db
    .prepare('SELECT transcript_state, transcript_summary FROM entries WHERE id = ?')
    .bind(entryId)
    .first<{ transcript_state: string | null; transcript_summary: string | null }>();
  if (row === null || !isTranscriptState(row.transcript_state)) return null;
  return {
    state: row.transcript_state,
    segments: await selectTranscriptSegments(db, entryId),
    summary: parseSummary(row.transcript_summary),
  };
}

/** 1 行 1 区間で「開始秒<TAB>テキスト」。区間の中の改行とタブは空白に畳む */
function formatSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `${segment.start.toFixed(1)}\t${segment.text.replace(/\s+/gu, ' ')}\n`)
    .join('');
}

function parseSegments(text: string): TranscriptSegment[] {
  return text.split('\n').flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return [];
    const start = Number(line.slice(0, tab));
    return Number.isFinite(start) ? [{ start, text: line.slice(tab + 1) }] : [];
  });
}
