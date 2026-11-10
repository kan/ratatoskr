import { httpHref, normalizeUrl } from './url';

/**
 * 記事の本文が参照しているリンク（issue #32）。
 *
 * 記事そのものではなく、記事が紹介している先をピンしたいことが多い（Bluesky の
 * 紹介系の投稿は、紹介先の URL を自リプライに付ける。サーバが「続きの投稿」として
 * 本文に足している。src/crawler/bluesky.ts）。リンク一覧（l）はここから作る。
 *
 * **抜き出しは手元で、サニタイズ済みの本文から行う。** 本文は取り込み時に
 * サニタイズされ、href は絶対 URL に直してある（不変条件 4、src/crawler/sanitize.ts）。
 * サーバに一覧を持たせると、本文と一覧の 2 つを同期させることになる。
 */

export interface ArticleLink {
  url: string;
  /** リンクの文字。画像だけのリンクは alt、それも無ければ空 */
  text: string;
}

/** リンク一覧（components/LinkList.vue）の 1 行 */
export interface LinkRow extends ArticleLink {
  /** 先頭の「この記事」。ピンは p（記事のピン）と同じものになる */
  self: boolean;
}

/**
 * リンク一覧の行。先頭に「この記事」、続けて本文中のリンク。
 * 記事が URL を持たなければ「この記事」の行は無い（開く先もピンする先も無い）
 */
export function linkRowsOf(
  entry: { url: string | null; title: string },
  links: readonly ArticleLink[],
): LinkRow[] {
  const rows = links.map((link) => ({ ...link, self: false }));
  if (entry.url === null) return rows;
  return [{ url: normalizeUrl(entry.url), text: entry.title, self: true }, ...rows];
}

/** DOM から拾った 1 つの `<a>`。判定を DOM から切り離してテストできるようにする */
export interface Anchor {
  href: string;
  text: string;
  /** 中の画像の alt。文字の無いリンク（画像のリンク）の呼び名に使う */
  alt: string;
}

/**
 * 一覧に出すリンクに絞る。
 *
 * - http / https だけ。mailto は開いてもピンしても用を成さない
 * - **URL の重複は先に出た方を残す。** 画像とキャプションが同じ先を指すリンクカード
 *   （src/crawler/bluesky.ts の renderExternal）で 2 行並ばないように。先に出た方に
 *   文字が無ければ（画像のリンク）、後の文字で埋める
 * - **`#タグ`・`@メンション` は除く。** 行き先は検索画面かプロフィールで、紹介先ではない。
 *   どのフィードでも文字で見分けられる。**見るのは 1 語だけのリンク文字。** 頭の 1 文字
 *   だけで決めると、「@IT の記事」「#1 おすすめ」のような普通のリンクまで落ちる
 * - 記事そのものの URL は除く。一覧の先頭に「この記事」として別に出す
 */
export function collectLinks(anchors: Iterable<Anchor>, entryUrl: string | null): ArticleLink[] {
  const self = entryUrl === null ? null : normalizeUrl(entryUrl);
  const byUrl = new Map<string, ArticleLink>();

  for (const anchor of anchors) {
    const url = httpHref(anchor.href);
    if (url === null || url === self) continue;

    const text = squash(anchor.text);
    if (TAG_OR_MENTION.test(text)) continue;

    const label = text === '' ? squash(anchor.alt) : text;
    const seen = byUrl.get(url);
    if (seen === undefined) byUrl.set(url, { url, text: label });
    else if (seen.text === '') seen.text = label;
  }
  return [...byUrl.values()];
}

/**
 * 描画済みの本文からリンクを拾う。
 *
 * **本文を読み解き直さない。** v-html が描いた DOM がもうあるので、そこから引く。
 * 本文の文字列を DOMParser にかけると、記事送りのたびに同じ HTML を 2 回パースする
 * ことになる（キーを押してから次の記事が出るまでの間に積まれる）
 */
export function linksIn(root: ParentNode, entryUrl: string | null): ArticleLink[] {
  const anchors = [...root.querySelectorAll('a[href]')].map((a) => ({
    href: a.getAttribute('href') ?? '',
    text: a.textContent ?? '',
    alt: a.querySelector('img[alt]')?.getAttribute('alt') ?? '',
  }));
  return collectLinks(anchors, entryUrl);
}

/** 2 つの一覧が同じ並びか。描き直しを省く判定に使う */
export function sameLinks(a: readonly ArticleLink[], b: readonly ArticleLink[]): boolean {
  return (
    a.length === b.length && a.every((link, i) => link.url === b[i].url && link.text === b[i].text)
  );
}

const TAG_OR_MENTION = /^[#＃@＠]\S+$/;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
