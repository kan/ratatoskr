/**
 * robots.txt（RFC 9309）の解釈。純関数だけを置く。取得と控えは src/crawler/polite.ts。
 *
 * 見るのは全文取得の記事ページと、RSS を出さないサイトのページだけ。フィード本体は
 * 利用者が明示的に購読したものなので対象にしない（migrations/0008_robots_txt.sql）。
 */

/** 自分の名乗りの製品トークン。USER_AGENT（src/crawler/fetch.ts）の頭と揃える */
const ROBOTS_PRODUCT_TOKEN = 'ratatoskr';

/** RFC 9309 §2.5: 少なくとも 500 KiB は読む。それより後ろは見ない */
export const MAX_ROBOTS_BYTES = 500 * 1024;

export type RobotsState = 'ok' | 'allow_all' | 'disallow_all';

export interface RobotsRule {
  allow: boolean;
  /** 比較用に正規化したパターン */
  pattern: string;
}

export interface RobotsRules {
  state: RobotsState;
  /** state が ok のとき、自分に効く規則（自分宛ての群が無ければ `*` の群） */
  rules: RobotsRule[];
}

/**
 * robots.txt の本文から、自分に効く規則を取り出す。
 *
 * - 群は「連続する user-agent 行」と、それに続く allow / disallow 行
 * - 自分の製品トークンに一致する群が 1 つでもあれば、その群（複数なら全部を合わせたもの）
 *   だけに従い、`*` の群は見ない（§2.2.1）
 * - 中身の空の `disallow:` は規則にならない（何も禁じない）
 */
export function parseRobots(body: string, token = ROBOTS_PRODUCT_TOKEN): RobotsRules {
  const mine: RobotsRule[] = [];
  const anyone: RobotsRule[] = [];
  let matchedMine = false;

  // いま読んでいる群の宛先。user-agent 行が続く間は足していき、規則の行を
  // 読んだ後に来た user-agent 行で新しい群を始める
  let agents: string[] = [];
  let inRules = false;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      if (value.toLowerCase() === token) matchedMine = true;
      continue;
    }
    if (key !== 'allow' && key !== 'disallow') continue;
    inRules = true;
    if (agents.length === 0 || value === '') continue;

    const rule = { allow: key === 'allow', pattern: normalizePath(value) };
    if (agents.includes(token)) mine.push(rule);
    if (agents.includes('*')) anyone.push(rule);
  }

  return { state: 'ok', rules: matchedMine ? mine : anyone };
}

/**
 * この URL を取りに行ってよいか。
 *
 * 一致した規則のうち、パターンの最も長いものが勝つ。同じ長さなら allow が勝つ（§2.2.2）。
 * `/robots.txt` 自体は常に許される（§2.2.2 の末尾）。
 */
export function isAllowed(rules: RobotsRules, url: string): boolean {
  if (rules.state === 'allow_all') return true;
  if (rules.state === 'disallow_all') return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = normalizePath(parsed.pathname + parsed.search);
  if (parsed.pathname === '/robots.txt') return true;

  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best === null || best.allow;
}

/**
 * `*`（任意の並び）と末尾の `$`（ここで終わる）を解する前方一致。
 *
 * 正規表現に組み立てない。パターンは相手のサイトが書いたもので、`*` を並べた
 * パターンを素朴な正規表現にすると後戻りが爆発しうる
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');

  // 先頭の断片は path の頭に一致しなければならない
  const head = parts[0];
  if (!path.startsWith(head)) return false;
  let pos = head.length;

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (i === parts.length - 1 && anchored) {
      // 最後の断片は path の末尾に置く（`*` の後ろなので、pos 以降のどこからでもよい）
      return path.length - part.length >= pos && path.endsWith(part);
    }
    const found = path.indexOf(part, pos);
    if (found < 0) return false;
    pos = found + part.length;
  }
  return anchored ? pos === path.length : true;
}

/**
 * パスを比較できる形にそろえる（§2.2.2）。
 *
 * パーセントエンコードの 16 進は大文字に、エンコードされていない ASCII 以外の文字は
 * UTF-8 でエンコードする。`/日本語` と `/%E6%97%A5...` を同じものとして比べるため。
 * `*` と `$` は記号のまま残す
 */
function normalizePath(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(path.slice(i + 1, i + 3))) {
      out += `%${path.slice(i + 1, i + 3).toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code > 0x7e || code < 0x21) {
      // サロゲートペアは 2 文字で 1 つの文字なので、まとめてエンコードする
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const chunk = isHigh ? path.slice(i, i + 2) : ch;
      if (isHigh) i += 1;
      try {
        out += encodeURIComponent(chunk);
      } catch {
        // 対になっていないサロゲート。比べようがないので素通しする
        out += chunk;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * HTTP の状態から、本文を読まずに決まる扱い（§2.3.1）。
 *
 * - 2xx … 本文を読む（null を返す）
 * - 4xx … 置いていない扱いで、全て許す。ただし 429 は流量の制限なので、5xx と同じく
 *   全て禁じる（RFC は 429 に触れていないが、「今は来るな」と言われて記事ページを
 *   取りに行く理由が無い）
 * - 5xx … 全て禁じる
 */
export function stateForStatus(status: number): Exclude<RobotsState, 'ok'> | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return 'disallow_all';
  if (status >= 400 && status < 500) return 'allow_all';
  return 'disallow_all';
}

/** robots.txt に禁じられたページを取りに行こうとした（src/crawler/polite.ts が投げる） */
export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt で禁じられている: ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

/**
 * robots.txt を取れなかったので、今はそのサイトのページを取りに行かない
 * （src/crawler/polite.ts が投げる）。
 *
 * **`RobotsDisallowedError` と分けるのは、こちらが一時的だから。** RFC 9309 §2.3.1.4 で
 * 全て禁じる扱いになるが、相手が直れば取りに行ける。禁じられたときと同じに扱うと、
 * 記事に取り直しを止める印が付き、購読管理画面にも誤った理由が出る
 */
export class RobotsUnavailableError extends Error {
  /** この秒数より前には robots.txt を取り直さない（控えの寿命） */
  readonly retryAfter: number;

  constructor(url: string, retryAfter: number) {
    super(`robots.txt を取れないので取りに行かなかった: ${url}`);
    this.name = 'RobotsUnavailableError';
    this.retryAfter = retryAfter;
  }
}
