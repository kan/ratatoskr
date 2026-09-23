/**
 * アソビチケット（https://asobiticket2.asobistore.jp/booths）の、申し込みの始まった
 * 受付を取り込む。
 *
 * **RSS を出していない。** 画面は SPA で、受付の一覧は裏の API（JSON:API 形式）から
 * 取ってくる。その API を引いて記事にする（docs/DESIGN.md の「RSS を出さないサイトを
 * 取り込む」）。
 *
 * - 受付（先行抽選、一般発売といった申し込みの窓口）1 件を 1 記事にする。公演
 *   （ブース）単位にしないのは、1 つの公演に受付が次々と足されるため
 * - **受付中のものだけを取り込む。** 受付には作成日時が無く、「新しく出た」は前に
 *   見た id との差分でしか分からない。差分は同一性判定（`INSERT OR IGNORE`）が
 *   そのまま担うので、受付前のものを外しておけば、受付の始まった回に初めて入る
 * - 一覧は公開中の受付を全件返し、800KB 近くある。ETag を返し If-None-Match で 304 に
 *   なるので、変化の無い回は本文を読まない
 */

import { RETENTION_DAYS } from '../../shared/types';
import { asArray, asObject, asString, parseJson } from '../lib/json';
import { apiChanged, notFetched, withFeed } from './api-feed';
import { parseDate } from './date';
import { fetchFeed, type FetchTarget } from './fetch';
import { escapeHtml } from './sanitize';
import { INITIAL_INTERVAL } from './schedule';
import type { KnownSource, ParsedItem, SourceOutcome } from './types';

const SITE_HOST = 'asobiticket2.asobistore.jp';
const SITE_URL = `https://${SITE_HOST}`;
const RECEPTIONS_URL = 'https://asobi-ticket.api.app.t-riple.com/api/v1/public/receptions';

/** 受付の id（UUID）。URL に埋めるので、想定外の文字は通さない */
const RECEPTION_ID = /^[0-9a-f-]+$/;

/** 受付の種類の表示名。知らない値はそのまま出す */
const ENTRY_TYPES: Record<string, string> = {
  lottery: '抽選',
  fcfs: '先着',
  resale_lottery: 'リセール（抽選）',
};

export const asobiTicket: KnownSource = {
  url: `${SITE_URL}/booths`,
  title: 'アソビチケット 受付中のチケット',
  // 先着の一般発売を 6 時間遅れで知っても役に立たない。304 で終わるので、
  // 1 時間おきでも 1 日 24 リクエストで済む
  maxInterval: INITIAL_INTERVAL,
  fetch: fetchReceptions,
};

async function fetchReceptions(
  target: FetchTarget,
  fetchImpl: typeof fetch,
  now: number,
): Promise<SourceOutcome> {
  // 取りに行くのは API で、条件付き GET の控え（ETag）も API のもの。
  // 作法はフィード本体と同じでよいので、fetchFeed に URL だけ差し替えて渡す
  const outcome = await fetchFeed({ ...target, url: RECEPTIONS_URL }, fetchImpl);
  if (outcome.kind !== 'fetched') return notFetched(outcome, '受付の一覧');

  const document = asObject(parseJson(outcome.body));
  if (document === null || !Array.isArray(document.data)) {
    return apiChanged('受付の一覧が読めない');
  }

  const included = indexIncluded(document.included);
  const items = document.data
    .map((reception) => toItem(reception, included, now))
    .filter((item) => item !== null)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return withFeed(outcome, { title: asobiTicket.title, siteUrl: SITE_URL, items });
}

/** JSON:API の `included` を `<type>:<id>` で引けるようにする */
function indexIncluded(included: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const value of asArray(included)) {
    const resource = asObject(value);
    const type = asString(resource?.type);
    const id = asString(resource?.id);
    if (resource !== null && type !== null && id !== null) index.set(`${type}:${id}`, resource);
  }
  return index;
}

/** 関連（`relationships.<name>.data`）の先を `included` から引く */
function related(
  resource: Record<string, unknown>,
  name: string,
  included: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const ref = asObject(asObject(asObject(resource.relationships)?.[name])?.data);
  const type = asString(ref?.type);
  const id = asString(ref?.id);
  if (type === null || id === null) return null;
  return included.get(`${type}:${id}`) ?? null;
}

function toItem(
  value: unknown,
  included: Map<string, Record<string, unknown>>,
  now: number,
): ParsedItem | null {
  const reception = asObject(value);
  const id = asString(reception?.id);
  const attributes = asObject(reception?.attributes);
  if (reception === null || attributes === null || id === null || !RECEPTION_ID.test(id)) {
    return null;
  }
  if (attributes.entry_period_status !== 'within_entry_period') return null;

  // **受付が始まって保持期間を過ぎたものは入れない。** 受付期間が保持期間より長いと、
  // 読んで消えた記事が、まだ受付中なので次の取得で新着として入り直す（src/retention.ts
  // は既読の記事を取り込みから 30 日で消す）。取り込みは受付の始まった後なので、
  // 始まりが保持期間より前なら、手元の記事も消えている可能性がある
  const startsAt = parseDate(attributes.entry_period_starts_at, now);
  if (startsAt !== null && startsAt < now - RETENTION_DAYS * 86_400) return null;

  const name = asString(attributes.name) ?? '';
  const tour = asString(asObject(related(reception, 'tour', included)?.attributes)?.name);
  return {
    guid: id,
    url: `${SITE_URL}/receptions/${id}`,
    title: tour === null ? name : `${tour} ／ ${name}`,
    author: null,
    body: renderBody(reception, attributes, included, now),
    publishedAt: startsAt,
  };
}

/**
 * 受付の本文。表紙の画像、受付期間、受付の種類、当落発表、受付の案内の順に並べる。
 *
 * 受付の案内（`top_body`）は外から来た HTML のまま入る。サニタイズは取り込みの
 * 共通の経路が通す（src/crawler/index.ts の toNewEntry）
 */
function renderBody(
  reception: Record<string, unknown>,
  attributes: Record<string, unknown>,
  included: Map<string, Record<string, unknown>>,
  now: number,
): string {
  const urls = asObject(
    asObject(related(reception, 'cover_image', included)?.attributes)?.reading_urls,
  );
  const cover = asString(urls?.large) ?? asString(urls?.original);
  const figure = cover === null ? '' : `<p><img src="${escapeHtml(cover)}" alt=""></p>`;

  const entryType = asString(attributes.entry_type);
  const at = (value: unknown): string | null => formatJst(parseDate(value, now));
  const from = at(attributes.entry_period_starts_at);
  const to = at(attributes.entry_period_ends_at);
  const facts = [
    ['受付期間', from === null && to === null ? null : `${from ?? ''} 〜 ${to ?? ''}`],
    ['受付の種類', entryType === null ? null : (ENTRY_TYPES[entryType] ?? entryType)],
    ['当落発表', at(attributes.result_announcement_scheduled_at)],
  ]
    .filter((fact): fact is [string, string] => fact[1] !== null)
    .map(([label, value]) => `<li>${escapeHtml(label)}: ${escapeHtml(value)}</li>`)
    .join('');
  const list = facts === '' ? '' : `<ul>${facts}</ul>`;

  return figure + list + (asString(attributes.top_body) ?? '');
}

/**
 * Unix 秒を日本時間の `2026/09/16 12:00` の形にする。
 *
 * 受付は日本の公演のものなので、読む側の端末の時間帯ではなく日本時間で出す。
 * 秒は落とす（終わりは `23:59:59.999` で来るので、秒まで出すと読みにくい）
 */
function formatJst(seconds: number | null): string | null {
  if (seconds === null) return null;
  const jst = new Date((seconds + 9 * 3600) * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ` +
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`
  );
}
