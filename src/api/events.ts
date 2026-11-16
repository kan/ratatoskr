import { MAX_EVENTS_PER_REQUEST as MAX_EVENTS, type ReadingEvent } from '../../shared/types';
import { insertReadingEvents } from '../db/events';
import { badRequest, readJsonBody } from '../lib/body';
import { json } from '../lib/errors';

/**
 * POST /api/events
 *
 * 読み方のデータ（issue #43）。クライアントの outbox からまとめて送られる。
 * id で冪等なので、重複して届いても 1 件になる。
 */

/** 表示時間の上限（秒）。端末の時計の狂いで桁違いの値が来ても集計を壊さない */
const MAX_SECONDS = 3600;

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function parseEvent(raw: unknown): ReadingEvent {
  if (typeof raw !== 'object' || raw === null) badRequest('events の要素はオブジェクトで送る');
  const event = raw as Record<string, unknown>;
  const { id, kind, at, feedId, entryId } = event;
  if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(id)) badRequest('id は英数字で送る');
  if (!Number.isSafeInteger(at) || (at as number) < 0) badRequest('at は Unix 秒で送る');
  if (!isId(feedId) || !isId(entryId)) badRequest('feedId と entryId は 1 以上の整数で送る');
  const base = { id: id as string, at: at as number, feedId, entryId };

  if (kind === 'dwell') {
    const seconds = event.seconds;
    if (!Number.isSafeInteger(seconds) || (seconds as number) < 0) {
      badRequest('seconds は 0 以上の整数で送る');
    }
    return { ...base, kind, seconds: Math.min(seconds as number, MAX_SECONDS) };
  }
  if (kind === 'link') {
    const url = event.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2048) {
      badRequest('url は http(s) の URL で送る');
    }
    return { ...base, kind, url: url as string };
  }
  if (kind === 'open') return { ...base, kind };
  return badRequest('kind は dwell / link / open のいずれか');
}

export async function postEvents(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) badRequest('events は配列で送る');
  if ((events as unknown[]).length > MAX_EVENTS) badRequest(`events は ${MAX_EVENTS} 件までで送る`);

  const parsed = (events as unknown[]).map(parseEvent);
  await insertReadingEvents(env.DB, parsed);
  return json({ accepted: parsed.length });
}
