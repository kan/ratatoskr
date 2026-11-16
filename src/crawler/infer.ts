import { asObject, parseJson } from '../lib/json';
import { readAnswer, parseChoice } from './choose';
import { recipeFeed, RECIPE_VERSION, scriptText, type Recipe, type RecipeField } from './recipe';
import { elementScope, htmlResponse } from './rewriter';
import type { ParsedFeed } from './types';

/**
 * RSS を出さないページから、取得定義（src/crawler/recipe.ts）を推定する（issue #40）。
 *
 * 全文取得の本文の位置決め（src/crawler/choose.ts）と同じ組み立てにする。
 *
 * 1. **候補は点数で作る。** ページを走査して「記事の一覧らしいもの」を機械的に拾い、
 *    それぞれを取得定義の形にする。HTML の繰り返し構造（リンクの並び）と、
 *    HTML に埋め込まれた JSON の配列（`__NEXT_DATA__` など）の 2 通り
 * 2. **確かめてから候補にする。** 作った定義を手元のページで実際になぞり、
 *    記事が MIN_ITEMS 件以上取れたものだけを残す
 * 3. **AI には選ばせるだけ。** 候補ごとの取れた見出しを見せて番号を答えさせる。
 *    AI が無い・答えが読めないなら点数の 1 位に落ちる
 *
 * **AI にセレクタを書かせない。** 書かせると、もっともらしいが当たらないものが返る。
 * 当たることを確かめた候補から選ばせれば、外れても「別の一覧を選んだ」で済む。
 *
 * 裏の API を叩く SPA は、素の HTML に記事が無いのでここでは見つからない。
 * 開発時に調べて定義を書く（docs/DESIGN.md「取得定義」）。
 */

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** 一覧と見なす最小の記事数。2 件ではナビゲーションと見分けが付かない */
export const MIN_ITEMS = 3;

/** AI に見せる候補の数 */
const MAX_CANDIDATES = 6;

/** 候補ごとに AI へ見せる見出しの数 */
const PREVIEW_TITLES = 4;

/** JSON を辿る深さと、見る配列の数の上限。巨大な `__NEXT_DATA__` で暴れないように */
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ARRAYS = 200;

export type RecipeSource = 'ai' | 'score';

export interface InferredRecipe {
  recipe: Recipe;
  source: RecipeSource;
  /** 手元のページでなぞった結果。購読の追加で、何が取れるかを見せるのに使う */
  feed: ParsedFeed;
}

const SYSTEM_PROMPT = [
  'You identify which candidate is the list of articles that a web page publishes,',
  'such as news, blog posts, press releases, or announcements, newest first.',
  'Each candidate shows how it was found and the titles it extracts.',
  'It is not navigation, a category or tag list, a ranking, related links, or ads.',
  'Answer with the number of the best candidate and nothing else.',
].join(' ');

interface Candidate {
  recipe: Recipe;
  score: number;
  /** AI に見せる、どう見つけたかの短い説明 */
  label: string;
}

export async function inferRecipe(
  html: string,
  pageUrl: string,
  pageTitle: string,
  ai: Ai | undefined,
  now: number,
): Promise<InferredRecipe | null> {
  const base: Pick<Recipe, 'version' | 'title' | 'siteUrl'> = {
    version: RECIPE_VERSION,
    ...(pageTitle === '' ? {} : { title: pageTitle }),
  };
  const drafts = [
    ...(await jsonCandidates(html, pageUrl, base)),
    ...(await htmlCandidates(html, pageUrl, base)),
  ];

  // 確かめる。日付まで取れたものは点を上げる
  const scored: (Candidate & { feed: ParsedFeed })[] = [];
  for (const draft of drafts) {
    const feed = await recipeFeed(draft.recipe, html, pageUrl, now);
    if (feed.items.length < MIN_ITEMS) continue;
    const dated = feed.items.some((item) => item.publishedAt !== null) ? 1.5 : 1;
    scored.push({ ...draft, feed, score: draft.score * dated });
  }
  scored.sort((a, b) => b.score - a.score);

  // 同じ記事の並びを指す候補は 1 つにする（JSON と HTML の両方で見つかる、日付の取り方
  // だけが違う）。**点の高い順に並べてから**残す。見つけた順に残すと、日付の取れない
  // 版が先に来たとき、日付の取れる版が捨てられる
  const verified: (Candidate & { feed: ParsedFeed })[] = [];
  const seen = new Set<string>();
  for (const candidate of scored) {
    const key = candidate.feed.items.map((item) => item.url).join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push(candidate);
  }
  if (verified.length === 0) return null;

  const shortlist = verified.slice(0, MAX_CANDIDATES);
  const top = shortlist[0];
  const byScore: InferredRecipe = { recipe: top.recipe, source: 'score', feed: top.feed };
  if (ai === undefined || shortlist.length === 1) return byScore;

  let answer: string;
  try {
    const result = await ai.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: describe(shortlist, pageUrl) },
      ],
      max_tokens: 8,
      temperature: 0,
    });
    answer = readAnswer(result);
  } catch {
    return byScore;
  }
  const index = parseChoice(answer, shortlist.length);
  if (index === null) return byScore;
  const chosen = shortlist[index];
  return { recipe: chosen.recipe, source: 'ai', feed: chosen.feed };
}

function describe(candidates: (Candidate & { feed: ParsedFeed })[], pageUrl: string): string {
  const lines = candidates.map((candidate, index) => {
    const titles = candidate.feed.items
      .slice(0, PREVIEW_TITLES)
      .map((item) => `   - ${item.title.slice(0, 80)}`);
    return [
      `${index + 1}. ${candidate.label} (${candidate.feed.items.length} items)`,
      ...titles,
    ].join('\n');
  });
  return `Page: ${pageUrl}\n\n${lines.join('\n')}\n\nWhich number is the list of articles?`;
}

// ---------------------------------------------------------------------------
// HTML の繰り返し構造
// ---------------------------------------------------------------------------

interface Frame {
  /** 走査の中で振る通し番号。同じ要素かどうかの判定に使う */
  serial: number;
  tag: string;
  id: string | null;
  className: string | null;
}

interface Anchor {
  href: string;
  path: Frame[];
  className: string | null;
  text: string;
}

/** ナビゲーションや脇の部品らしい入れ物。ここに入っているリンクの並びは点を下げる */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
const CHROME_CLASS =
  /(nav|menu|header|footer|breadcrumb|pager|pagination|sidebar|side-|ranking|tag|category|share|sns|banner|ad-)/i;

/** セレクタに使ってよいクラス名。状態や乱数のようなもの（`css-1x2y3z`）は避けたいが、見分けきれないので字種だけ見る */
const SAFE_CLASS = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

async function htmlCandidates(
  html: string,
  pageUrl: string,
  base: Pick<Recipe, 'version' | 'title' | 'siteUrl'>,
): Promise<Candidate[]> {
  const anchors = await scanAnchors(html, pageUrl);
  const groups = new Map<string, Anchor[]>();
  for (const anchor of anchors) {
    const key = `${anchor.path.map(frameKey).join(' ')} a${anchor.className ? `.${anchor.className}` : ''}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [anchor]);
    else group.push(anchor);
  }

  const out: Candidate[] = [];
  const selectors = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < MIN_ITEMS) continue;
    // 文字の無いリンクの並び（サムネイルの画像）は見出しにならない。同じ記事の要素を
    // 指す見出しのリンクの並びが別にあるので、そちらに譲る
    const avgText =
      group.reduce((sum, anchor) => sum + Math.min(anchor.text.length, 60), 0) / group.length;
    if (avgText < 4) continue;
    const located = locateItem(group);
    if (located === null || selectors.has(located.item)) continue;
    selectors.add(located.item);

    const distinct = new Set(group.map((anchor) => anchor.href)).size;
    const chrome = group[0].path.some(
      (frame) => CHROME_TAGS.has(frame.tag) || CHROME_CLASS.test(frame.className ?? ''),
    );
    const main = group[0].path.some((frame) => frame.tag === 'main' || frame.tag === 'article');
    const score = distinct * avgText * (chrome ? 0.2 : 1) * (main ? 1.5 : 1);

    const link: RecipeField =
      located.link === null ? { attr: 'href' } : { selector: located.link, attr: 'href' };
    const title: RecipeField = located.link === null ? {} : { selector: located.link };
    out.push({
      score,
      label: `HTML list "${located.item}"`,
      recipe: {
        ...base,
        list: {
          url: pageUrl,
          format: 'html',
          items: located.item,
          fields: {
            url: link,
            title,
            publishedAt: { selector: 'time', attr: 'datetime' },
            image: { selector: 'img', attr: 'src' },
          },
        },
      },
    });
  }
  return withDateFallbacks(out);
}

/**
 * 日付の取り方を確かめずに `time[datetime]` で決め打ちしているので、`<time>` を
 * 使わないサイト向けに「date を名に含むクラスのテキスト」に差し替えた版も候補にする。
 * どちらが当たるかは確かめ（inferRecipe）が決める
 */
function withDateFallbacks(candidates: Candidate[]): Candidate[] {
  return candidates.flatMap((candidate) => {
    const textDate: Recipe = {
      ...candidate.recipe,
      list: {
        ...candidate.recipe.list,
        fields: {
          ...candidate.recipe.list.fields,
          publishedAt: { selector: '[class*="date"]' },
        },
      },
    };
    return [candidate, { ...candidate, recipe: textDate, score: candidate.score * 0.99 }];
  });
}

/**
 * リンクの並びから、記事 1 件を包む要素のセレクタを決める。
 *
 * 並んだリンクの祖先を外から見ていき、**初めて別々の要素に分かれる段**が記事の要素。
 * その 1 つ上が並びの入れ物。全ての段で同じ要素なら、リンクが入れ物の直下に並んで
 * いるので、リンク自体を記事の要素にする。
 */
function locateItem(group: Anchor[]): { item: string; link: string | null } | null {
  const depth = group[0].path.length;
  let split = depth;
  for (let level = 0; level < depth; level += 1) {
    const serials = new Set(group.map((anchor) => anchor.path[level].serial));
    if (serials.size > 1) {
      split = level;
      break;
    }
  }
  // 記事の要素ごとにリンクが 1 本でなければ、並びとしては使えない（1 件の中に
  // 複数の記事が混ざる）。同じ記事へのリンクが 2 本（画像と見出し）は許す
  if (split < depth) {
    const byItem = new Map<number, Set<string>>();
    for (const anchor of group) {
      const serial = anchor.path[split].serial;
      const hrefs = byItem.get(serial) ?? new Set<string>();
      hrefs.add(anchor.href);
      byItem.set(serial, hrefs);
    }
    if ([...byItem.values()].some((hrefs) => hrefs.size > 1)) return null;
    if (byItem.size < MIN_ITEMS) return null;
  }

  // 入れ物は 2 段まで遡って書く。1 段だと別の場所の同じ形（`ul > li`）まで当たる
  const containers = group[0].path
    .slice(Math.max(0, split - 2), split)
    .map((frame) => frameSelector(frame));
  const anchorSel = `a${group[0].className ? `.${group[0].className}` : ''}`;
  if (split === depth) {
    if (containers.length === 0) return null;
    return { item: `${containers.join(' ')} > ${anchorSel}`, link: null };
  }
  const item = `${[...containers, '>'].join(' ')} ${frameSelector(group[0].path[split], false)}`
    .replace(/^> /, '')
    .trim();
  return { item, link: anchorSel };
}

function frameKey(frame: Frame): string {
  return `${frame.tag}${frame.className ? `.${frame.className}` : ''}`;
}

/** セレクタの 1 段。id は入れ物にだけ使う（記事の要素の id は 1 件ごとに違う） */
function frameSelector(frame: Frame, useId = true): string {
  if (useId && frame.id !== null) return `${frame.tag}#${frame.id}`;
  return frameKey(frame);
}

async function scanAnchors(html: string, pageUrl: string): Promise<Anchor[]> {
  const stack: Frame[] = [];
  const anchors: Anchor[] = [];
  const open: Anchor[] = [];
  let serial = 0;
  let hidden = 0;
  let origin: string;
  try {
    origin = new URL(pageUrl).host;
  } catch {
    return [];
  }

  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
        elementScope(
          element,
          () => (hidden += 1),
          () => (hidden -= 1),
        );
        return;
      }
      const firstClass = (element.getAttribute('class') ?? '').trim().split(/\s+/)[0] ?? '';
      const id = element.getAttribute('id');
      const frame: Frame = {
        serial: (serial += 1),
        tag,
        id: id !== null && SAFE_CLASS.test(id) ? id : null,
        className: SAFE_CLASS.test(firstClass) ? firstClass : null,
      };

      // **終了タグの手当ては 1 要素に 1 回。** リンクの記録と祖先の積み下ろしを
      // 1 つの出口にまとめる
      let anchor: Anchor | null = null;
      if (tag === 'a') {
        const href = element.getAttribute('href');
        const resolved = href === null ? null : sameSiteArticle(href, pageUrl, origin);
        if (resolved !== null) {
          anchor = { href: resolved, path: [...stack], className: frame.className, text: '' };
        }
      }
      const recorded = anchor;
      elementScope(
        element,
        () => {
          stack.push(frame);
          if (recorded !== null) open.push(recorded);
        },
        () => {
          // 閉じ忘れの要素（`<li>` の終了タグ省略）で積み残しが出ても、
          // 自分より上を巻き込んで外す
          const at = stack.lastIndexOf(frame);
          if (at >= 0) stack.length = at;
          if (recorded !== null) {
            open.splice(open.indexOf(recorded), 1);
            recorded.text = recorded.text.replace(/\s+/g, ' ').trim();
            anchors.push(recorded);
          }
        },
      );
    },
    text(chunk) {
      if (hidden > 0) return;
      for (const anchor of open) {
        if (anchor.text.length < 200) anchor.text += chunk.text;
      }
    },
  });
  await rewriter.transform(htmlResponse(html)).text();
  return anchors;
}

/** 同じサイトの、記事らしいページへのリンクか。トップ・ページ内・ファイルへのリンクは除く */
function sameSiteArticle(href: string, pageUrl: string, host: string): string | null {
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.host.replace(/^www\./, '') !== host.replace(/^www\./, '')) return null;
  if (url.pathname === '/' || /\.(jpe?g|png|gif|webp|pdf|zip)$/i.test(url.pathname)) return null;
  url.hash = '';
  return url.href;
}

// ---------------------------------------------------------------------------
// HTML に埋め込まれた JSON
// ---------------------------------------------------------------------------

const TITLE_KEYS = ['title', 'headline', 'name', 'subject'];
const URL_KEYS = ['url', 'href', 'link', 'permalink', 'uri'];
const DATE_KEYS = [
  'publishedAt',
  'published_at',
  'datePublished',
  'date',
  'publishDate',
  'published',
  'startdate',
  'createdAt',
  'created_at',
  'updatedAt',
];
const IMAGE_KEYS = ['image', 'thumbnail', 'thumbnailUrl', 'thumb', 'eyecatch', 'imageUrl'];
const SUMMARY_KEYS = ['description', 'summary', 'excerpt', 'lead', 'abstract'];

async function jsonCandidates(
  html: string,
  pageUrl: string,
  base: Pick<Recipe, 'version' | 'title' | 'siteUrl'>,
): Promise<Candidate[]> {
  const scripts = await jsonScripts(html);
  const out: Candidate[] = [];
  for (const selector of scripts) {
    const text = await scriptText(html, selector);
    if (text === null) continue;
    const root = parseJson(text);
    for (const array of findArrays(root)) {
      const fields = mapFields(array.sample, pageUrl);
      if (fields === null) continue;
      out.push({
        score: array.length * 40,
        label: `embedded JSON ${selector} at "${array.path}"`,
        recipe: {
          ...base,
          list: {
            url: pageUrl,
            format: 'embedded-json',
            script: selector,
            items: array.path,
            fields,
          },
        },
      });
    }
  }
  return out;
}

/** JSON の入った `<script>` を指すセレクタ。id のあるものは id で、無いものは型の最初の 1 つ */
async function jsonScripts(html: string): Promise<string[]> {
  const selectors: string[] = [];
  const rewriter = new HTMLRewriter().on('script', {
    element(element) {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (type !== 'application/json' && type !== 'application/ld+json') return;
      const id = element.getAttribute('id');
      const selector =
        id !== null && SAFE_CLASS.test(id) ? `script#${id}` : `script[type="${type}"]`;
      if (!selectors.includes(selector)) selectors.push(selector);
    },
  });
  await rewriter.transform(htmlResponse(html)).text();
  return selectors;
}

interface FoundArray {
  path: string;
  length: number;
  sample: Record<string, unknown>[];
}

/** 3 件以上のオブジェクトの配列を、根からのパスと一緒に拾う */
function findArrays(root: unknown): FoundArray[] {
  const found: FoundArray[] = [];
  const walk = (value: unknown, path: string[], depth: number): void => {
    if (depth > MAX_JSON_DEPTH || found.length >= MAX_JSON_ARRAYS) return;
    if (Array.isArray(value)) {
      const objects = value.map(asObject).filter((v) => v !== null);
      if (objects.length >= MIN_ITEMS && objects.length === value.length) {
        found.push({ path: path.join('.'), length: value.length, sample: objects.slice(0, 5) });
      }
      // 配列の中の配列（記事ごとのタグ）まで追う意味は薄いので、先頭だけ見る
      if (value.length > 0) walk(value[0], [...path, '0'], depth + 1);
      return;
    }
    const object = asObject(value);
    if (object === null) return;
    for (const [key, child] of Object.entries(object)) {
      if (key.includes('.')) continue;
      walk(child, [...path, key], depth + 1);
    }
  };
  walk(root, [], 0);
  // `0` を通るパスは「先頭の要素の中の配列」なので、一覧ではない
  return found.filter((array) => !array.path.split('.').includes('0'));
}

/** 配列の要素の形から、取得定義の値の取り方を決める。見出しと URL が無ければ null */
function mapFields(
  sample: Record<string, unknown>[],
  pageUrl: string,
): Recipe['list']['fields'] | null {
  const keyOf = (keys: string[], ok: (value: unknown) => boolean): string | null =>
    keys.find((key) => sample.every((item) => ok(item[key]))) ?? null;
  const isText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
  const isUrl = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value, pageUrl);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        (value.startsWith('/') || /^https?:/i.test(value))
      );
    } catch {
      return false;
    }
  };

  const title = keyOf(TITLE_KEYS, isText);
  const url = keyOf(URL_KEYS, isUrl);
  if (title === null || url === null) return null;
  const date = keyOf(DATE_KEYS, (v) => isText(v) || typeof v === 'number');
  const image = keyOf(IMAGE_KEYS, isUrl);
  const summary = keyOf(SUMMARY_KEYS, isText);
  return {
    url: { path: url },
    title: { path: title },
    ...(date === null ? {} : { publishedAt: { path: date } }),
    ...(image === null ? {} : { image: { path: image } }),
    ...(summary === null ? {} : { summary: { path: summary } }),
  };
}
