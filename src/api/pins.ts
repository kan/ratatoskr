import type { CreatePinRequest, PinResponse } from '../../shared/types';
import { deletePin, insertPin } from '../db/pins';
import { badRequest, readJsonBody } from '../lib/body';
import { json } from '../lib/errors';

/**
 * ピンの追加と削除（docs/API.md「ピン」）。
 *
 * 「読む」と「後で処理する」を分けるための機能なので、既読とは独立している。
 * ピンしても記事は既読化の対象から外れない（docs/UX.md）。
 */

/** 極端に長いタイトルで DB を膨らませない。表示にも使わない長さ */
const MAX_TITLE_LENGTH = 500;

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') badRequest('title は必須');
  return (value as string).trim().slice(0, MAX_TITLE_LENGTH);
}

function parseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') badRequest('url は必須');

  let url: URL;
  try {
    url = new URL((value as string).trim());
  } catch {
    return badRequest('url が URL として読めない');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    badRequest('url は http か https で指定する');
  }
  return url.href;
}

function parseEntryId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    badRequest('entryId は 1 以上の整数で指定する');
  }
  return value as number;
}

export async function createPin(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const input = body as Partial<CreatePinRequest>;

  // 記事が既に消えていることがある（オフラインでピンした後に購読を解除した等）。
  // その場合は参照だけ落として作る（クエリ層の副問い合わせが引き受ける）
  const pin = await insertPin(
    env.DB,
    {
      entryId: parseEntryId(input.entryId),
      title: parseTitle(input.title),
      url: parseUrl(input.url),
    },
    Math.floor(Date.now() / 1000),
  );

  const responseBody: PinResponse = { pin };
  return json(responseBody, 201);
}

export async function removePin(env: Env, id: number): Promise<Response> {
  // 既に消えている場合も、送り直しで消したい相手はもう無いので成功として扱う。
  // outbox の再送が 404 で詰まらないようにするため（冪等。docs/DESIGN.md §6）
  const deleted = await deletePin(env.DB, id);
  return json({ deleted: deleted ? id : null });
}
