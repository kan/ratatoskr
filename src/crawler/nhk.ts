/**
 * NHK ONE のニュース記事を、記事ページではなく記事の JSON から取ってくる。
 *
 * **記事ページの本文は、閲覧用のトークンが無いとリードで切れる。** NHK ONE は初回に
 * 「利用の確認」（受信契約についての確認）を求め、それを済ませたブラウザにだけ
 * 全文を返す。確認を済ませると、アカウントに紐付かないトークンが発行される。
 * 記事ページを走査しても、トークンが無ければリードしか入っていない。
 *
 * 全文は記事ページの HTML より、ページが裏で読んでいる JSON から採る方が確か。
 * トークンを `Authorization` に付けると、`detailedArticleBody` に Markdown に近い独自書式の
 * 全文が入る。HTML の側は Next.js の描画結果で、本文の位置を当てる必要がある。
 *
 * **トークンは取り込みのたびに取り直す。** リダイレクトを 3 回たどるだけで発行され、
 * 有効期限は 8 時間。NHK の新着は数時間に数本なので、取りに行く回は少ない。
 * 保存して使い回すと、期限切れと取り直しの扱いが D1 に増える。
 *
 * 受信契約があり、個人が使う前提で組んでいる（issue #18）。
 */

import { asObject, asString } from '../lib/json';
import {
  describeNetworkError,
  releaseBudget,
  reserveBudget,
  TIMEOUT_MS,
  USER_AGENT,
  type FetchBudget,
} from './fetch';
import { escapeHtml, sanitizeHtml } from './sanitize';

const ARTICLE_HOST = 'news.web.nhk';
const ARTICLE_PATH = /^\/newsweb\/na\/([a-z]+-[0-9a-z]+)\/?$/;

const API_BASE = 'https://api.web.nhk/r8/t/newsarticle/na/';

/** トークンの発行口。ブラウザの「利用の確認」ボタンが遷移する先と同じ */
const AUTHORIZE_URL = 'https://news.web.nhk/tix/build_authorize';

/**
 * 発行を受けたあとに戻る先。戻った先のページは読まない（トークンは戻る直前の応答の
 * クッキーで届く）。ブラウザは開いていた記事の URL を渡すので、NHK ONE の中の URL にしてある
 */
const RETURN_URL = 'https://news.web.nhk/newsweb/';

/**
 * 「利用の確認」で立つクッキー。**受信契約のある世帯として利用に同意した**という意味になる。
 *
 * 地域はブラウザでは利用者が選ぶ。ここでは、ブラウザが海外向けの確認で使う既定値
 * （東京都千代田区）に揃えてある。この値で全国の記事の全文が返ることは確かめた
 */
const CONSENT = JSON.stringify({
  status: 'optedin',
  entity: 'household',
  area: { areaId: '130', jisx0402: '13101', postal: '1000001', pref: '13' },
});

/**
 * トークンの取得に使う要求の数（発行口 → 認可サーバ → 戻り先。実測 3 回）。
 *
 * **確保する枠とたどる上限を同じ数にする。** たどる側にだけ余裕を持たせると、NHK 側が
 * 段を足したときに確保していない要求を送り、サブリクエストの上限を超えうる。
 * 段が増えたらトークンが取れなくなり、ログに出る
 */
const TOKEN_REQUESTS = 3;

/** アクセストークンが入るクッキーの名前 */
const TOKEN_COOKIE = 'z_at';

/**
 * 記事 URL が NHK ONE のニュース記事を指しているか。指していれば記事 id を返す。
 *
 * **フィードの URL では判断しない**（Bluesky と同じ理由。src/crawler/bluesky.ts）。
 * 振り分けは記事ごとに決める
 */
export function nhkArticleId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ARTICLE_HOST) return null;
  return ARTICLE_PATH.exec(parsed.pathname)?.[1] ?? null;
}

export interface NhkOptions {
  fetchImpl: typeof fetch;
  budget: FetchBudget;
}

export interface NhkArticles {
  /** 記事 id → 組み立てた HTML */
  bodies: Map<string, string>;
  /**
   * 取りに行って、確かに無かった記事の id（消された記事・本文の空な記事）。
   *
   * **取りに行けなかったものは入れない。** トークンが取れなかった・API が落ちている・
   * 予算が届かなかった、はどれも時間を置けば直る。呼び出し側はこれを取り直しを
   * 止める印に使う（src/crawler/fulltext.ts の FillOutcome）
   */
  missing: Set<string>;
}

/**
 * 記事を組み立てて返す。
 *
 * 要求はトークンの取得に 3 回と、記事ごとに 1 回。
 */
export async function fetchNhkArticles(
  ids: readonly string[],
  options: NhkOptions,
): Promise<NhkArticles> {
  const result: NhkArticles = { bodies: new Map(), missing: new Set() };
  if (ids.length === 0) return result;

  // トークンの分と記事 1 本の分が揃わなければ取りに行かない。トークンだけ取って
  // 記事を 1 本も引けないと、その 3 回は丸ごと無駄になる
  const granted = reserveBudget(options.budget, TOKEN_REQUESTS + ids.length);
  if (granted < TOKEN_REQUESTS + 1) {
    releaseBudget(options.budget, granted);
    return result;
  }

  const slots = granted - TOKEN_REQUESTS;
  const token = await acquireToken(options.fetchImpl);
  // 記事の分は返す。発行口が落ちているだけなら次の機会に取れる
  if (token === null) {
    releaseBudget(options.budget, slots);
    return result;
  }

  let fetched = 0;
  for (const id of ids.slice(0, slots)) {
    fetched += 1;
    const outcome = await fetchArticle(id, token, options.fetchImpl);
    // **一時的な失敗が出たら残りは取りに行かない。** トークンが受け付けられない・
    // API が落ちている、はどちらも記事によらないので、残りも同じ結果になる
    // （応答しない API なら打ち切りの待ちが記事の数だけ積み重なる）。残りは次の機会に回る
    if (outcome.kind === 'retry') break;
    if (outcome.kind === 'gone') {
      result.missing.add(id);
      continue;
    }
    const rendered = renderArticle(outcome.article);
    // 自前で組み立てた HTML でも必ずサニタイズを通す（CLAUDE.md の不変条件 4）
    const html = rendered === '' ? '' : await sanitizeHtml(rendered, articleUrl(id));
    if (html === '') result.missing.add(id);
    else result.bodies.set(id, html);
  }
  releaseBudget(options.budget, slots - fetched);
  return result;
}

function articleUrl(id: string): string {
  return `https://${ARTICLE_HOST}/newsweb/na/${id}`;
}

/**
 * 閲覧用のトークンを取る。取れなければ null。
 *
 * ブラウザの「利用の確認」がしていることを、リダイレクトを自分でたどって再現する。
 * **`redirect: 'follow'` に任せられないのは、途中でクッキーを受け渡すため。**
 * 発行口は `__HOST-bff-code` というクッキーを渡してきて、戻り先はそれと一緒に
 * トークンを発行する（発行口の遷移先に PKCE の code_challenge が付いているので、
 * その検証に使うものと見ている）。Workers の fetch はクッキーを持ち越さない。
 */
async function acquireToken(fetchImpl: typeof fetch): Promise<string | null> {
  const jar = new Map<string, string>([['consentToUse', encodeURIComponent(CONSENT)]]);
  const params = new URLSearchParams({
    idp: 'r-alaz',
    profileType: 'anonymous',
    redirect_uri: RETURN_URL,
  });
  let url = `${AUTHORIZE_URL}?${params}`;

  for (let hop = 0; hop < TOKEN_REQUESTS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          'user-agent': USER_AGENT,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn('NHK ONE のトークンの取得に失敗', url, describeNetworkError(err).message);
      return null;
    }
    await response.body?.cancel();
    storeCookies(jar, response.headers);

    const token = jar.get(TOKEN_COOKIE);
    if (token !== undefined) return token;

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    url = new URL(location, url).href;
  }
  console.warn('NHK ONE のトークンが発行されなかった');
  return null;
}

/**
 * Set-Cookie を手元の入れ物に反映する。**値が空のものは消す**
 * （発行口は古いトークンを `max-age=0` の空値で消してくる）。
 * 属性（domain / path / 期限）は見ない。1 回の取得の間しか持たないので要らない
 */
function storeCookies(jar: Map<string, string>, headers: Headers): void {
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

type ArticleOutcome =
  | { kind: 'ok'; article: Record<string, unknown> }
  /** 記事が消えている。取り直しても結果は変わらない */
  | { kind: 'gone' }
  /** 一時的な失敗。次の機会に回す */
  | { kind: 'retry' };

async function fetchArticle(
  id: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ArticleOutcome> {
  const url = `${API_BASE}${encodeURIComponent(id)}.json`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('NHK ONE の記事の取得に失敗', url, describeNetworkError(err).message);
    return { kind: 'retry' };
  }
  if (response.status === 404 || response.status === 410) return { kind: 'gone' };
  if (!response.ok) return { kind: 'retry' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'retry' };
  }
  const article = asObject(payload);
  // **本文の欄が無いのは、トークンが受け付けられなかったとき。** 記事が無いのではない。
  // 印を付けると、トークンの発行が一時的に壊れた回の記事が二度と埋まらなくなる
  // 応答の形が変わったときも同じ道を通るので、気付けるようログに残す
  if (article === null || asObject(article.detailedArticleBody) === null) {
    console.warn('NHK ONE の記事に本文の欄が無い（トークンが受け付けられていない？）', url);
    return { kind: 'retry' };
  }
  return { kind: 'ok', article };
}

/**
 * 記事 1 本を HTML に落とす。メイン画像、リード、本文の順に並べる。
 *
 * **メイン画像を足すのは、RSS にも本文の書式にも入っていないため。** 記事ページでは
 * 見出しの下に出ている。`<img>` で本文に入って初めて画像の先読みが効く。
 *
 * **生の HTML ブロックを除いた版（`noHtml…`）を優先する。** 生の HTML ブロックは
 * 地図や動画の iframe で、サニタイズで落ちると見出しとリンクの残骸だけが残る。
 * 除いた版は生の HTML ブロックを含む記事にしか付かないので、無ければ元の版を使う
 */
export function renderArticle(article: Record<string, unknown>): string {
  const detail = asObject(article.detailedArticleBody);
  const lead = asString(detail?.noHtmlMarkedLead) ?? asString(detail?.markedLead) ?? '';
  const body = asString(detail?.noHtmlMarkedBody) ?? asString(detail?.markedBody) ?? '';

  const image = asString(asObject(asObject(article.image)?.medium)?.url);
  const figure = image === null ? '' : `<figure><img src="${escapeHtml(image)}" alt=""></figure>`;

  const text = renderMarked(lead) + renderMarked(body);
  // 本文が空なら画像だけの全文にしない。呼び出し側が「採らなかった」印を付ける
  return text === '' ? '' : figure + text;
}

/**
 * NHK ONE の本文の書式を HTML にする。
 *
 * Markdown の一部に独自の拡張が載ったもので、実際の記事に出てくるのは次のとおり。
 *
 * - 段落は空行区切り。行末の `\` は段落内の改行
 * - `## 見出し {id=…}`（属性は捨てる）、`![alt](URL)`、`**太字**`、`***` / `----` の区切り線
 * - `:::nw--link-type4 {href=…}` 〜 `:::`：関連記事へのカード。中身は画像と太字の題
 * - `:::nw--border {…}` / `:::nw--colored {…}` 〜 `:::`：囲み記事。枠の色しか持たない
 * - `==NEW=={…}` / `==注目=={…}`：見出しに付くバッジ。読むのに要らないので捨てる
 * - ```` ```raw-html ```` 〜 ```` ``` ````：生の HTML。`noHtml…` 版には無いが、念のため捨てる
 *
 * 汎用の Markdown パーサを使わないのは、独自の拡張の方が本文の構造を決めているため。
 * 拡張を知らないパーサに通すと、囲みの記号や属性がそのまま本文に残る。
 */
export function renderMarked(source: string): string {
  const html: string[] = [];
  /** いま開いている関連記事カードの行き先。カードの外なら null */
  let cardHref: string | null = null;
  let paragraph: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (paragraph.length === 0) return;
    html.push(renderParagraph(paragraph, cardHref));
    paragraph = [];
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimEnd();

    if (inFence) {
      if (line.startsWith('```')) inFence = false;
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      inFence = true;
      continue;
    }

    const container = /^:::\s*([\w-]*)\s*(\{.*\})?$/.exec(line);
    if (container !== null) {
      flush();
      if (container[1] === '') {
        // 囲みの閉じ。カードなら引用の枠を閉じる
        if (cardHref !== null) html.push('</blockquote>');
        cardHref = null;
      } else if (container[1] === 'nw--link-type4') {
        // カードは引用の枠で本文と分ける。行き先が読めなければ囲み記事と同じく枠なしにする
        cardHref = /href=([^\s}]+)/.exec(container[2] ?? '')?.[1] ?? null;
        if (cardHref !== null) html.push('<blockquote>');
      }
      // 囲み記事（border / colored）は枠を付けない。中の見出しが区切りになる
      continue;
    }

    if (line === '') {
      flush();
      continue;
    }

    // バッジだけの行（`==NEW=={class=… datetime=…}`）
    if (/^(==[^=]+==\{[^}]*\}\s*)+$/.test(line)) continue;

    const heading = /^(#{2,4})\s+(.*?)\s*(\{[^}]*\})?$/.exec(line);
    if (heading !== null) {
      flush();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2], null)}</h${level}>`);
      continue;
    }

    if (/^(\*{3,}|-{3,})$/.test(line)) {
      flush();
      html.push('<hr>');
      continue;
    }

    paragraph.push(line);
  }
  flush();
  // 閉じ忘れたカードも閉じる（HTML の入れ子を壊さない）
  if (cardHref !== null) html.push('</blockquote>');
  return html.join('');
}

/**
 * 段落 1 つ。画像だけの段落は figure にする。
 *
 * **行の区切りは全て `<br>` にする。** 行末の `\` は明示の改行で、`\` の無い改行も
 * NHK の書式では改行として書かれている（Markdown の規則どおり空白で繋ぐと、
 * 日本語の文の途中に空白が入る）。
 */
function renderParagraph(lines: string[], cardHref: string | null): string {
  const text = lines.map((line) => line.replace(/\\$/, '')).join('\n');
  const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(text);
  if (image !== null) {
    const img = `<img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}">`;
    return cardHref === null
      ? `<figure>${img}</figure>`
      : `<figure><a href="${escapeHtml(cardHref)}">${img}</a></figure>`;
  }
  return `<p>${renderInline(text, cardHref).replaceAll('\n', '<br>')}</p>`;
}

/**
 * 段落の中。**先にエスケープしてから記号を置き換える。** 記号（`**` `[` `]` `(` `)`）は
 * エスケープで変わらないので、置き換えた後のタグだけが HTML として残る。
 *
 * カードの中の太字は題なので、カードの行き先へのリンクにする。
 */
function renderInline(text: string, cardHref: string | null): string {
  const strong = (inner: string): string =>
    cardHref === null
      ? `<strong>${inner}</strong>`
      : `<a href="${escapeHtml(cardHref)}"><strong>${inner}</strong></a>`;

  return escapeHtml(text)
    .replace(/==[^=]+==\{[^}]*\}/g, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, (_, inner: string) => strong(inner));
}
