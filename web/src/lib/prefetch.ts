import type { Entry } from '@shared/types';
import { PREFETCH_IMAGE_CACHE } from '@/lib/sw-policy';

/**
 * 画像の先読み（docs/DESIGN.md §6「画像の先読みは別扱い」）。
 *
 * 本文 JSON は全件手元に落とせるが、画像は数十 MB になり得るので落とせない。
 * そこで LDRoid のカーソル相対ウィンドウ方式を画像に転用する。ウィンドウに入った
 * 画像だけを先に取りに行き、外れたものは捨てる。
 *
 * 読む順序と先読み順序が一致していることが、先読みが当たる前提条件
 * （CLAUDE.md の不変条件 2）。ウィンドウの中身を決めるのはカーソルの所有者
 * （stores/feeds.ts）で、ここはその並びを受け取って取りに行くだけ。
 *
 * **温まるのは 2 箇所ある。** `<img>` が読むのはブラウザの HTTP キャッシュで、
 * Cache API ではない（Cache API は Service Worker がリクエストを横取りして初めて
 * 効く）。記事送りを速くしているのは前者で、Cache API に書いた分は Service Worker
 * （src/sw.ts）がオフラインで画像を出すために読む。fetch 1 回で両方温まるので、
 * 分けて取りに行く必要はない。
 */

/**
 * Cache API の名前。**Service Worker（src/sw.ts）と共有している**ので、
 * 定義は lib/sw-policy.ts に置いてある。E2E からも同じものを参照する
 */
export const CACHE_NAME = PREFETCH_IMAGE_CACHE;

/** 同時に取りに行く数。相手のサーバに配慮して広げない（docs/DESIGN.md §6） */
const CONCURRENCY = 4;

/**
 * **同じサイトへは同時に 2 本まで。**
 *
 * 全体の並列度だけで絞ると、1 本のフィードの画像が窓を埋めたときに 4 本とも同じサイトに
 * ぶら下がる。記事画像が数 MB あるサイト（デイリーポータルZ は原寸 5MB だった）では、
 * それを 40 枚ぶん一息に取りに行くことになり、相手にとっては短時間の集中アクセスになる。
 * 窓の広さ（枚数）は変えず、1 サイトあたりの太さだけを絞る。
 */
const PER_HOST = 2;

export interface ImagePrefetcher {
  /** ウィンドウを入れ替える。urls は読む順に並んでいること */
  update(urls: string[]): void;
  /** テスト用。走っている先読みと破棄が片付くまで待つ */
  idle(): Promise<void>;
}

export interface PrefetcherDeps {
  fetchImpl?: typeof fetch;
  /** null を返せば HTTP キャッシュを温めるだけになる */
  openCache?: () => Promise<Cache | null>;
  concurrency?: number;
  /** 同じサイトへの同時本数。テストから絞る */
  perHost?: number;
}

export function createImagePrefetcher(deps: PrefetcherDeps = {}): ImagePrefetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openCache = deps.openCache ?? openImageCache;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const perHost = deps.perHost ?? PER_HOST;

  /** これから取りに行く URL。読む順に並べる */
  let queue: string[] = [];
  /** いま取りに行っている URL。同じ URL を二重に取りに行かないための束ね */
  const inFlight = new Map<string, Promise<void>>();
  /** 温め終わった URL。ウィンドウから外れたら捨てる対象になる */
  const warmed = new Set<string>();
  /** 現在のウィンドウ。取り終えた時点でまだウィンドウ内かを見るのに使う */
  let windowUrls = new Set<string>();
  /** 走っている破棄。同じ URL を置き直すときは、これが片付くのを待つ */
  const dropping = new Map<string, Promise<void>>();
  /** サイトごとの、いま取りに行っている本数 */
  const hostLoad = new Map<string, number>();
  /** caches.open は 1 回でよい。開けなかった結果も含めて使い回す */
  let cache: Promise<Cache | null> | null = null;

  function openCacheOnce(): Promise<Cache | null> {
    cache ??= openCache();
    return cache;
  }

  function update(urls: string[]): void {
    const next = new Set(urls);

    // ウィンドウから外れたものを捨てる。捨てないと Cache API が読んだ分だけ太る。
    // HTTP キャッシュには残るので、k で戻ったときに取り直しにはならない
    for (const url of warmed) {
      if (next.has(url)) continue;
      warmed.delete(url);
      drop(url);
    }

    windowUrls = next;
    // まだ取っていないものだけを読む順に積み直す。走り出しているものは止めない。
    // ほぼ取り終えているものを捨てる方が無駄になるので、打ち切るのは順番待ちだけ
    queue = [...next].filter((url) => !warmed.has(url) && !inFlight.has(url));
    pump();
  }

  function pump(): void {
    while (inFlight.size < concurrency) {
      // 読む順のまま、いま取りに行ける最初のものを選ぶ。同じサイトが上限に達していたら
      // 飛ばして先へ進む（そのサイトの 1 本が終わったときに拾い直される）
      const index = queue.findIndex((url) => canStart(url));
      if (index === -1) return;

      const [url] = queue.splice(index, 1);
      const host = hostOf(url);
      hostLoad.set(host, (hostLoad.get(host) ?? 0) + 1);

      const task = warm(url).finally(() => {
        inFlight.delete(url);
        const left = (hostLoad.get(host) ?? 1) - 1;
        if (left > 0) hostLoad.set(host, left);
        else hostLoad.delete(host);
        pump();
      });
      inFlight.set(url, task);
    }
  }

  function canStart(url: string): boolean {
    if (warmed.has(url) || inFlight.has(url)) return false;
    return (hostLoad.get(hostOf(url)) ?? 0) < perHost;
  }

  async function warm(url: string): Promise<void> {
    let response: Response;
    try {
      // 中身を読む必要は無いので no-cors で十分。cookie も送らない
      response = await fetchImpl(url, { mode: 'no-cors', credentials: 'omit' });
    } catch {
      // 先読みの失敗は表示に影響しない（読めば普通に取りに行く）。記録もしない
      return;
    }
    // 取り終えた頃にはウィンドウから外れていることがある
    if (!windowUrls.has(url)) return;
    warmed.add(url);

    const store = await openCacheOnce();
    // Cache API が無くても（secure context でない等）HTTP キャッシュは温まっている。
    //
    // 本体を読み捨てたり cancel したりはしない。no-cors の応答は opaque で
    // body が null なので、そもそも掴めない。読まずに放置してもブラウザは
    // 最後まで受け取ってキャッシュに載せる（実測: 放置したあとの 2 回目が 2ms、
    // 未取得の URL は 70ms）
    if (store === null) return;

    // 同じ URL の破棄が走っていたら、片付いてから置く。
    // j の直後に k で戻ると「捨てる」と「置き直す」が並ぶ
    await dropping.get(url);
    // 待っている間にウィンドウから外れていることがある。ここで置いてしまうと、
    // warmed からは既に落ちているので二度と捨てられない
    if (!windowUrls.has(url)) {
      warmed.delete(url);
      return;
    }
    try {
      // no-cors の応答は opaque（status 0）だが Cache API には置ける
      await store.put(url, response);
    } catch {
      // 容量超過や opaque を置けない実装。HTTP キャッシュは温まっているので続行
    }
  }

  function drop(url: string): void {
    const task = (async () => {
      const store = await openCacheOnce();
      if (store === null) return;
      try {
        await store.delete(url);
      } catch {
        // 消せなくても実害は無い
      }
    })().finally(() => {
      // 自分より後に積まれた破棄が残っているなら、そちらに任せる
      if (dropping.get(url) === task) dropping.delete(url);
    });
    dropping.set(url, task);
  }

  async function idle(): Promise<void> {
    // 1 本終わるたびに pump が次を積むので、空になるまで繰り返す
    while (inFlight.size > 0 || dropping.size > 0) {
      await Promise.allSettled([...inFlight.values(), ...dropping.values()]);
    }
  }

  return { update, idle };
}

/** 同時本数を数える単位。解釈できない URL は 1 つのまとまりとして扱う */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function openImageCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

let shared: ImagePrefetcher | null = null;

/**
 * カーソルの所有者（stores/feeds.ts）から呼ぶ入口。
 *
 * ブラウザ以外（ユニットテストの Node）では何もしない。先読みは速さのための
 * 手段でしかないので、動かない環境では黙って省く。
 */
export function prefetchImages(urls: string[]): void {
  // 見るのは「ブラウザか」だけ。Cache API の有無で判断してはいけない。
  // caches は secure context にしか無く、スマホから http://<LAN の IP>:5173 で
  // 触るときに消える。そのときも HTTP キャッシュは温まるので、先読みは止めない
  if (typeof window === 'undefined') return;
  shared ??= createImagePrefetcher();
  shared.update(urls);
}

// サニタイズ済みの img に残る属性は src / alt / title の 3 つだけで、src は
// 絶対 URL に正規化済み（crawler/sanitize.ts）。だから DOM を組み立てずに拾える
const IMG_SRC = /<img\b[^>]*?\ssrc="([^"]*)"/gi;

/**
 * 本文から画像の URL を拾う。
 *
 * DOM を作らないのは、記事送りのたびにウィンドウを組み直すため。1 記事ごとに
 * DOMParser を回すと、押した瞬間に次の記事を出すという目標に直接効いてしまう。
 * 属性値に `>` を含むような書き方は取りこぼすが、取りこぼしても先読みが 1 枚
 * 減るだけで表示は壊れない。
 */
export function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(IMG_SRC)) {
    const url = match[1];
    // data: や相対 URL は温める意味が無い（前者は本文と一緒に手元にある）
    if (url.startsWith('https://') || url.startsWith('http://')) urls.push(url);
  }
  return urls;
}

/**
 * 記事の画像 URL。記事は取り込み後に書き換わらないので結果を覚えておく。
 * キーを記事そのものにしてあるので、全文取得（M7 後半）で本文が差し替わった
 * ときは別の記事として拾い直される。
 */
const imageUrlMemo = new WeakMap<Entry, string[]>();

export function imageUrlsOf(entry: Entry): string[] {
  const cached = imageUrlMemo.get(entry);
  if (cached !== undefined) return cached;

  const urls = extractImageUrls(entry.body);
  imageUrlMemo.set(entry, urls);
  return urls;
}
