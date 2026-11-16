import { asArray, asObject, asString, parseJson } from '../lib/json';
import { apiChanged, notFetched, withFeed } from './api-feed';
import { parseDate } from './date';
import { fetchFeed, type FetchOutcome, type FetchTarget } from './fetch';
import { extractHtmlItems } from './recipe-html';
import { escapeHtml } from './sanitize';
import { htmlResponse } from './rewriter';
import { httpUrl } from './url';
import type { ParsedFeed, ParsedItem, SourceOutcome } from './types';

/**
 * 取得定義（issue #40）。RSS を出さないサイトから記事の一覧を組み立てる手順を、
 * コードではなくデータで持つ。
 *
 * **決めるのは設定するときだけで、クロールでは LLM を呼ばない。** 定義は
 * `feeds.recipe` に JSON で保存し、取り込みはそれをなぞるだけなので、同じページからは
 * 毎回同じ記事が出る。定義を作る経路は 2 つある（docs/DESIGN.md「取得定義」）。
 *
 * - 購読の追加で、貼られたページから推定する（src/crawler/infer.ts）。静的な HTML と、
 *   HTML に埋め込まれた JSON はこちら
 * - 開発時に Claude Code がサイトを調べて書き、購読の追加で貼る。裏の API を叩く SPA
 *   （トークンを取ってから一覧を引く、など）はこちら
 *
 * 定義が作るのは `ParsedFeed`（パーサの出力と同じ形）まで。サニタイズ、`guid_hash`、
 * `INSERT OR IGNORE`、取得間隔はこれまでどおり共通の経路を通す。本文は一覧に載る
 * 範囲（要約・サムネイル）までで、記事ページの本文が欲しければ全文取得を入れる。
 */

export const RECIPE_VERSION = 1;

/** 1 つの値の取り出し方 */
export interface RecipeField {
  /** html: 記事の要素の中を指すセレクタ。省けば記事の要素そのもの */
  selector?: string;
  /** html: 読む属性。省けば中のテキスト */
  attr?: string;
  /** json / embedded-json: 記事のオブジェクトからの JSON パス（`a.b.0.c`） */
  path?: string;
  /**
   * 取り出した値を埋める型。`{}` が値に置き換わる（`https://example.com/news/{}`）。
   * 値は URL の一部として埋めるので、encodeURIComponent を通す
   */
  template?: string;
}

/** 一覧の前に引く要求。返った JSON から値を取り、後の URL の `{名前}` に埋める */
export interface RecipeStep {
  url: string;
  /** 名前 → JSON パス */
  capture: Record<string, string>;
}

export interface Recipe {
  version: typeof RECIPE_VERSION;
  /** 購読の名前。省けばページの題 */
  title?: string;
  /** サイトのトップ。相対 URL の基準にもなる。省けば一覧の URL */
  siteUrl?: string;
  steps?: RecipeStep[];
  list: {
    /** 一覧の URL。`{名前}` に steps で取った値が入る */
    url: string;
    format: 'html' | 'json' | 'embedded-json';
    /** embedded-json: JSON が入った `<script>` を指すセレクタ */
    script?: string;
    /** html: 記事 1 件を包む要素のセレクタ。json: 記事の配列への JSON パス（`''` で根） */
    items: string;
    fields: {
      url: RecipeField;
      title: RecipeField;
      /** 省けば url を同一性の判定に使う */
      guid?: RecipeField;
      publishedAt?: RecipeField;
      /** 本文にするテキスト（要約）。HTML は取らない（テキストとして入れる） */
      summary?: RecipeField;
      /** サムネイルの URL。本文の頭に `<img>` で入れる（画像の先読みの対象にするため） */
      image?: RecipeField;
      author?: RecipeField;
    };
    /** 全てを満たす記事だけを採る（json / embedded-json のみ） */
    filter?: { path: string; equals: string | number | boolean }[];
  };
}

const FIELD_NAMES = ['url', 'title', 'guid', 'publishedAt', 'summary', 'image', 'author'] as const;
type FieldName = (typeof FIELD_NAMES)[number];

/** 一覧から取る記事数の上限。取り込みの上限（MAX_ITEMS_PER_FEED）と揃える */
const MAX_ITEMS = 100;

/** 前段の要求の数。定義が壊れて同じ要求を延々と繰り返さないように */
const MAX_STEPS = 3;

/** 本文にする要約の長さの上限 */
const MAX_SUMMARY = 2000;

/**
 * 外から来た定義（API に貼られた JSON、DB から読んだ JSON）を確かめる。
 * 読めなければ理由を返す。**クロールで初めて壊れていると分かる形を通さない**
 */
export function parseRecipe(value: unknown): Recipe | string {
  const root = asObject(typeof value === 'string' ? parseJson(value) : value);
  if (root === null) return '取得定義はオブジェクトで書く';
  if (root.version !== RECIPE_VERSION) return `version は ${RECIPE_VERSION} にする`;

  const list = asObject(root.list);
  if (list === null) return 'list が無い';
  const listUrl = asString(list.url);
  if (listUrl === null || !isHttpTemplate(listUrl)) return 'list.url は http(s) の URL で書く';
  const format = list.format;
  if (format !== 'html' && format !== 'json' && format !== 'embedded-json') {
    return 'list.format は html / json / embedded-json のいずれか';
  }
  const items = asString(list.items);
  if (items === null || (format === 'html' && items === '')) return 'list.items が無い';
  const script = asString(list.script) ?? undefined;
  if (format === 'embedded-json' && script === undefined) return 'embedded-json には script が要る';

  const rawFields = asObject(list.fields);
  if (rawFields === null) return 'list.fields が無い';
  const fields: Partial<Record<FieldName, RecipeField>> = {};
  for (const name of FIELD_NAMES) {
    if (rawFields[name] === undefined) continue;
    const field = parseField(rawFields[name], format);
    if (typeof field === 'string') return `fields.${name}: ${field}`;
    fields[name] = field;
  }
  if (fields.url === undefined || fields.title === undefined)
    return 'fields に url と title が要る';

  const filter: { path: string; equals: string | number | boolean }[] = [];
  for (const raw of asArray(list.filter)) {
    const condition = asObject(raw);
    const path = asString(condition?.path);
    const equals = condition?.equals;
    if (
      path === null ||
      (typeof equals !== 'string' && typeof equals !== 'number' && typeof equals !== 'boolean')
    ) {
      return 'filter は { path, equals } の並び';
    }
    filter.push({ path, equals });
  }
  if (filter.length > 0 && format === 'html') return 'filter は json / embedded-json でだけ使える';

  const steps: RecipeStep[] = [];
  for (const raw of asArray(root.steps)) {
    const step = asObject(raw);
    const url = asString(step?.url);
    const capture = asObject(step?.capture);
    if (url === null || !isHttpTemplate(url) || capture === null) {
      return 'steps は { url, capture } の並び';
    }
    const names: Record<string, string> = {};
    for (const [name, path] of Object.entries(capture)) {
      if (typeof path !== 'string') return 'capture の値は JSON パスで書く';
      names[name] = path;
    }
    steps.push({ url, capture: names });
  }
  if (steps.length > MAX_STEPS) return `steps は ${MAX_STEPS} 個まで`;

  const title = asString(root.title) ?? undefined;
  const siteUrl = asString(root.siteUrl) ?? undefined;
  if (siteUrl !== undefined && !isHttpTemplate(siteUrl)) return 'siteUrl は http(s) の URL で書く';

  return {
    version: RECIPE_VERSION,
    ...(title === undefined ? {} : { title }),
    ...(siteUrl === undefined ? {} : { siteUrl }),
    ...(steps.length === 0 ? {} : { steps }),
    list: {
      url: listUrl,
      format,
      ...(script === undefined ? {} : { script }),
      items,
      fields: fields as Recipe['list']['fields'],
      ...(filter.length === 0 ? {} : { filter }),
    },
  };
}

function parseField(value: unknown, format: Recipe['list']['format']): RecipeField | string {
  const field = asObject(value);
  if (field === null) return 'オブジェクトで書く';
  const out: RecipeField = {};
  for (const key of ['selector', 'attr', 'path', 'template'] as const) {
    const v = field[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') return `${key} は文字列で書く`;
    out[key] = v;
  }
  if (format === 'html' && out.path !== undefined) return 'html では path ではなく selector を使う';
  if (format !== 'html' && out.path === undefined) return 'path が要る';
  if (out.template !== undefined && !out.template.includes('{}')) return 'template には {} が要る';
  return out;
}

function isHttpTemplate(url: string): boolean {
  // `{名前}` は後で埋めるので、URL として読めるかは埋めてから確かめる
  return /^https?:\/\/[^/\s]+/i.test(url);
}

/** 定義をなぞって記事の一覧を組み立てる。取り込み（src/crawler/source.ts）から呼ぶ */
export interface RunOptions {
  /**
   * 記事が 1 件も取れなかったときに、取れた一覧のページから推定し直す
   * （src/crawler/recipe-source.ts）。取れた記事を返すか、駄目なら null
   */
  reinfer?: (body: string, listUrl: string) => Promise<ParsedFeed | null>;
}

export async function runRecipe(
  recipe: Recipe,
  target: FetchTarget,
  fetchImpl: typeof fetch,
  now: number,
  options: RunOptions = {},
): Promise<SourceOutcome> {
  const values: Record<string, string> = {};
  for (const [index, step] of (recipe.steps ?? []).entries()) {
    const url = fillTemplate(step.url, values);
    if (url === null) return apiChanged(`取得定義の手順 ${index + 1} の URL を組み立てられない`);
    const outcome = await fetchFeed(
      { url, etag: null, lastModified: null, contentHash: null },
      fetchImpl,
    );
    if (outcome.kind !== 'fetched') return notFetched(outcome, `手順 ${index + 1}`);
    const data = parseJson(outcome.body);
    for (const [name, path] of Object.entries(step.capture)) {
      const value = scalarText(atPath(data, path));
      if (value === null) return apiChanged(`手順 ${index + 1} で ${name} が取れない`);
      values[name] = value;
    }
  }

  const listUrl = fillTemplate(recipe.list.url, values);
  if (listUrl === null) return apiChanged('取得定義の一覧の URL を組み立てられない');
  // 前段の値（トークン）が URL に入ると、条件付き GET の控えは毎回外れる。
  // 一覧の中身が同じなら content_hash で打ち切れるので、控えは渡したままでよい
  const outcome: FetchOutcome = await fetchFeed(
    recipe.steps === undefined
      ? { ...target, url: listUrl }
      : { ...target, url: listUrl, etag: null, lastModified: null },
    fetchImpl,
  );
  if (outcome.kind !== 'fetched') return notFetched(outcome, '一覧');

  const feed = await recipeFeed(recipe, outcome.body, listUrl, now);
  if (feed.items.length > 0) return withFeed(outcome, feed);

  const reinferred = await options.reinfer?.(outcome.body, listUrl);
  if (reinferred !== null && reinferred !== undefined && reinferred.items.length > 0) {
    return withFeed(outcome, reinferred);
  }
  // **取れた本文の控え（content_hash）は返さない。** 返すと、同じページが続く間は
  // 「変わっていない」で打ち切られ、定義を直しても次の取得まで試されない
  return apiChanged('取得定義で記事が 1 件も取れない（ページの作りが変わった可能性）');
}

/**
 * 取れた一覧の本文から `ParsedFeed` を組み立てる。推定（src/crawler/infer.ts）が
 * 定義を確かめるのにも使う（取りに行き直さずに、手元のページで試す）
 */
export async function recipeFeed(
  recipe: Recipe,
  body: string,
  listUrl: string,
  now: number,
  scripts?: ScriptCache,
): Promise<ParsedFeed> {
  const base = recipe.siteUrl ?? listUrl;
  const raws =
    recipe.list.format === 'html'
      ? await extractHtmlItems(body, recipe.list.items, recipe.list.fields)
      : await jsonItems(recipe, body, scripts);

  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const raw of raws.slice(0, MAX_ITEMS * 2)) {
    const item = toItem(raw, base, now);
    if (item === null) continue;
    const key = item.guid ?? item.url ?? '';
    // 同じ記事へのリンクが一覧に 2 度出る（サムネイルと見出しの両方が リンク）
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }

  // 日付が取れるなら新しい順に並べる（取り込みは逆順に入れる。src/crawler/types.ts）。
  // 取れないなら一覧の並び（ふつうは新しい順）のまま
  if (items.some((item) => item.publishedAt !== null)) {
    items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  }
  return { title: recipe.title ?? '', siteUrl: recipe.siteUrl ?? null, items };
}

/** 取り出したままの値。null は「無かった」 */
export type RawItem = Partial<Record<FieldName, string | number | null>>;

/**
 * 同じページの `<script>` の中身の控え（セレクタ → 中身）。推定は 1 ページに対して候補の数だけ
 * なぞるので、埋め込み JSON の候補ごとにページを走査し直さないために渡す
 */
export type ScriptCache = Map<string, Promise<string | null>>;

export function cachedScript(
  html: string,
  selector: string,
  scripts: ScriptCache | undefined,
): Promise<string | null> {
  if (scripts === undefined) return scriptText(html, selector);
  let text = scripts.get(selector);
  if (text === undefined) {
    text = scriptText(html, selector);
    scripts.set(selector, text);
  }
  return text;
}

async function jsonItems(recipe: Recipe, body: string, scripts?: ScriptCache): Promise<RawItem[]> {
  const { list } = recipe;
  const text =
    list.format === 'embedded-json' ? await cachedScript(body, list.script ?? '', scripts) : body;
  if (text === null) return [];
  const array = atPath(parseJson(text), list.items);
  if (!Array.isArray(array)) return [];

  const out: RawItem[] = [];
  for (const element of array) {
    if (!(list.filter ?? []).every((c) => atPath(element, c.path) === c.equals)) continue;
    const raw: RawItem = {};
    for (const name of FIELD_NAMES) {
      const field = list.fields[name];
      if (field?.path === undefined) continue;
      const value = atPath(element, field.path);
      raw[name] = applyTemplate(
        typeof value === 'number' ? value : scalarText(value),
        field.template,
      );
    }
    out.push(raw);
  }
  return out;
}

function toItem(raw: RawItem, base: string, now: number): ParsedItem | null {
  const url = absolute(text(raw.url), base);
  const title = (text(raw.title) ?? '').replace(/\s+/g, ' ').trim();
  if (url === null || title === '') return null;

  const image = absolute(text(raw.image), base);
  const summary = (text(raw.summary) ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
  const body =
    (image === null ? '' : `<p><img src="${escapeHtml(image)}" alt=""></p>`) +
    (summary === '' ? '' : `<p>${escapeHtml(summary)}</p>`);

  return {
    guid: text(raw.guid),
    url,
    title,
    author: text(raw.author),
    body,
    publishedAt: dateOf(raw.publishedAt, now),
  };
}

/**
 * 日付を Unix 秒にする。数値なら Unix 時刻（ミリ秒らしければ秒に直す）、
 * 文字列なら日付の表記として読む（`2026.11.16` のような区切りも受ける）
 */
function dateOf(value: string | number | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const seconds = value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
    return seconds > 0 && seconds <= now + 86_400 ? seconds : null;
  }
  const trimmed = value.trim();
  // **日付だけの表記は日本時間の 0 時とする。** 日本のサイトに多い `2026.11.16` /
  // `2026/11/16` / `2026年11月16日` で、Date.parse に任せると UTC の 0 時（日本の 9 時）に
  // なるか、読めずに落ちる。時刻まで書いてあるものは Date.parse に任せ、読めなければ
  // 前後に文字の付いた日付（`公開日: 2026.11.16`）として拾う
  const match = JP_DATE.exec(trimmed);
  const dateOnly = match !== null && /^\s*日?$/.test(trimmed.slice(match.index + match[0].length));
  if (match !== null && match.index === 0 && dateOnly) return jstMidnight(match, now);
  return parseDate(trimmed, now) ?? (match === null ? null : jstMidnight(match, now));
}

/** `2026.11.16` / `2026/11/16` / `2026年11月16日` / `2026-11-16` */
const JP_DATE = /(\d{4})\s*[./年-]\s*(\d{1,2})\s*[./月-]\s*(\d{1,2})/;

function jstMidnight(match: RegExpExecArray, now: number): number | null {
  const [, y, m, d] = match;
  return parseDate(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00+09:00`, now);
}

function text(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function absolute(url: string | null, base: string): string | null {
  return url === null ? null : (httpUrl(url, base)?.href ?? null);
}

/** `{}` に値を埋める。値は URL の一部として埋まるのでエンコードする */
export function applyTemplate(
  value: string | number | null,
  template: string | undefined,
): string | number | null {
  if (value === null || template === undefined) return value;
  return template.replace('{}', encodeURIComponent(String(value)));
}

/** `{名前}` を steps で取った値で埋める。埋まらない名前が残れば null */
function fillTemplate(template: string, values: Record<string, string>): string | null {
  let missing = false;
  const filled = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return encodeURIComponent(value);
  });
  if (missing) return null;
  try {
    return new URL(filled).href;
  } catch {
    return null;
  }
}

/** `a.b.0.c` の形の JSON パスを辿る。`''` は根そのもの */
export function atPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    const object = asObject(current);
    if (object === null || !Object.hasOwn(object, segment)) return undefined;
    current = object[segment];
  }
  return current;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** HTML の中の `<script>` 1 つの中身を取る（embedded-json） */
export async function scriptText(html: string, selector: string): Promise<string | null> {
  let found: string | null = null;
  let buffer = '';
  let capturing = false;
  const rewriter = new HTMLRewriter().on(selector, {
    element() {
      if (found !== null || capturing) return;
      capturing = true;
      buffer = '';
    },
    text(chunk) {
      if (!capturing) return;
      buffer += chunk.text;
      if (chunk.lastInTextNode) {
        found = buffer;
        capturing = false;
      }
    },
  });
  await rewriter.transform(htmlResponse(html)).text();
  return found;
}
