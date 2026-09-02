import type { CreatePinRequest, PinResponse } from '../../shared/types';
import { titleFromBody } from '../crawler/title';
import { selectEntriesByIds } from '../db/entries';
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

/**
 * 見出し。**空を断らない。**
 *
 * タイトルを配らないフィード（Bluesky のプロフィール RSS など）の記事は title が空で、
 * 画面が「(無題)」を出しているだけ（web/src/components/EntryReader.vue）。ここで 400 を
 * 返すと、outbox は 4xx を「送り直しても通らない」としてキューから落とす
 * （web/src/stores/outbox.ts の isPermanent）ので、**ピンした本人には何も起きたように
 * 見えないまま、リロードで消える**（issue #11）。
 */
function parseTitle(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return badRequest('title は文字列で送る');
  return value.trim().slice(0, MAX_TITLE_LENGTH);
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

/**
 * 見出しが空なら、記事の本文の書き出しで補う（M7 の「タイトルを配らないフィード」と
 * 同じ規則。src/crawler/title.ts）。
 *
 * **ピンは記事より長生きする**ので、控える見出しは作れるうちに作っておく。記事が消えた
 * 後に残るのが URL だけでは、一覧を見ても何をピンしたのか分からない。取りに行くのは
 * 見出しが無いときだけなので、普段のピンに往復は増えない。
 */
async function fillTitle(db: D1Database, title: string, entryId: number | null): Promise<string> {
  if (title !== '' || entryId === null) return title;

  // 本文の採り方（全文が取れていればそちら）はクエリ層に任せる
  const [entry] = await selectEntriesByIds(db, [entryId]);
  return entry === undefined ? '' : await titleFromBody(entry.body);
}

export async function createPin(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null) badRequest('ボディはオブジェクトで送る');
  const input = body as Partial<CreatePinRequest>;

  const entryId = parseEntryId(input.entryId);
  const url = parseUrl(input.url);
  const title = await fillTitle(env.DB, parseTitle(input.title), entryId);

  // 記事が既に消えていることがある（オフラインでピンした後に購読を解除した等）。
  // その場合は参照だけ落として作る（クエリ層の副問い合わせが引き受ける）
  const pin = await insertPin(env.DB, { entryId, title, url }, Math.floor(Date.now() / 1000));

  const responseBody: PinResponse = { pin };
  return json(responseBody, 201);
}

export async function removePin(env: Env, id: number): Promise<Response> {
  // 既に消えている場合も、送り直しで消したい相手はもう無いので成功として扱う。
  // outbox の再送が 404 で詰まらないようにするため（冪等。docs/DESIGN.md §6）
  const deleted = await deletePin(env.DB, id);
  return json({ deleted: deleted ? id : null });
}
