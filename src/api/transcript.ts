import { selectTranscript } from '../db/transcripts';
import { ApiError, json } from '../lib/errors';

/**
 * GET /api/entries/:id/transcript — Podcast のエピソードの文字起こし（issue #46）
 *
 * 全文は記事に載せずに、開いたときにここから取る。2 時間半で 6〜8 万字あり、起動時に
 * 全記事を落とす同期（docs/DESIGN.md §6）に混ぜると、エピソード 1 本ごとに数百 KB 増える。
 * 要約も返す。読み流した後に要約が届いた記事（差分同期は未読しか届け直さない）でも、
 * ここを開けば読める。
 */
export async function getTranscript(env: Env, entryId: number): Promise<Response> {
  const transcript = await selectTranscript(env.DB, entryId);
  if (transcript === null) {
    throw new ApiError('not_found', `記事 ${entryId} の文字起こしは無い`, 404);
  }
  return json(transcript);
}
