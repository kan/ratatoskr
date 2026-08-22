/**
 * Service Worker の取り決め（docs/DESIGN.md §8）。
 *
 * ここはページ側（先読み・E2E）と Service Worker の**両方**から読まれる。
 * キャッシュの名前と、どの要求をどう扱うかの分岐を 1 箇所に置くためのモジュールで、
 * DOM にも WebWorker の API にも触らない（だから両方から import できるし、
 * 素の vitest で分岐だけを試せる）。
 *
 * sw.ts は別のビルドで組み立てる（web/vite.sw.config.ts）。名前や分岐をあちらに
 * 直接書くと、先読みが使うキャッシュ名とずれても誰も気付けない。
 */

/** アプリシェル（index.html）。ナビゲーション要求はここから出す */
export const SHELL_CACHE = 'ratatoskr-shell-v1';
/** ハッシュ付きの資産（/assets/）。中身が変わらないので消さずに使い回す */
export const ASSET_CACHE = 'ratatoskr-assets-v1';
/** 手元に控える API の応答。オフラインで起動したときの退避先 */
export const API_CACHE = 'ratatoskr-api-v1';
/** Service Worker が通りがかりに温めた画像。上限を超えたら古い順に捨てる */
export const IMAGE_CACHE = 'ratatoskr-images-runtime-v1';
/**
 * 先読み（lib/prefetch.ts）が温める画像。**あちらが中身を管理している**ので、
 * Service Worker は読むだけで書かない。名前を 1 箇所に持たないと、ずれた瞬間に
 * 先読みした画像がオフラインで出なくなる（誰も気付けない類の壊れ方）
 */
export const PREFETCH_IMAGE_CACHE = 'ratatoskr-images-v1';

/** 版を上げたときに古いキャッシュを見分けるための接頭辞 */
export const CACHE_PREFIX = 'ratatoskr-';

/** アプリシェルを控えるときの key。どのパスで開いても SPA は同じ HTML を返す */
export const SHELL_URL = '/';

/**
 * 画像を手元に置く上限。1 枚 100–300KB として数十 MB に収まる程度に留める。
 * 先読みのウィンドウ（40 枚）より十分大きく取り、読み返しの範囲を覆う
 */
export const IMAGE_LIMIT = 150;

/** 現に使っているキャッシュ。activate でこれ以外の ratatoskr- を捨てる */
export const LIVE_CACHES: readonly string[] = [
  SHELL_CACHE,
  ASSET_CACHE,
  API_CACHE,
  IMAGE_CACHE,
  PREFETCH_IMAGE_CACHE,
];

/**
 * 要求の扱い方。
 *
 * - `bypass` … 素通しする（Service Worker は何もしない）
 * - `shell`  … ナビゲーション。ネットワーク優先、繋がらなければ控えの HTML
 * - `static` … favicon や manifest。ナビゲーションと同じ扱い
 * - `asset`  … ハッシュ付きの資産。手元にあれば取りに行かない
 * - `api`    … ネットワーク優先、繋がらなければ控えの応答
 * - `image`  … 記事の画像。手元にあれば取りに行かない
 */
export type SwRoute = 'bypass' | 'shell' | 'static' | 'asset' | 'api' | 'image';

export interface RequestFacts {
  method: string;
  url: string;
  /** Service Worker 自身のオリジン */
  origin: string;
  /** Request.destination（'image' / 'document' / 'script' …） */
  destination: string;
  /** Request.mode。ナビゲーション要求の判定に使う */
  mode: string;
}

/**
 * 手元に控える API。
 *
 * **bootstrap だけ。** 記事の中身は起動シーケンスが IndexedDB に落としていて
 * （docs/DESIGN.md §6）、オフラインでもそちらから描ける。/api/entries まで控えると
 * 同じ記事を 2 通りの形で数 MB ずつ抱えることになるので置かない。
 * bootstrap を控えるのは、手元が空の状態でオフラインになった場合の最後の砦。
 */
const CACHEABLE_API: ReadonlySet<string> = new Set(['/api/bootstrap']);

/** 拡張子で終わるパス。/manifest.json や /favicon.svg を指す */
const FILE_PATH = /\.[a-z0-9]+$/i;

export function routeFor(facts: RequestFacts): SwRoute {
  // **書き込みは絶対に握らない。** 既読とピンの送信は keepalive / sendBeacon で
  // 離脱後も届くことを当てにしている（CLAUDE.md の不変条件 3）。間に入ると
  // その保証がこちらの実装次第になる
  if (facts.method !== 'GET') return 'bypass';

  const url = new URL(facts.url, facts.origin);

  if (url.origin !== facts.origin) {
    // **記事の画像はここにしか無い。** 自分のオリジンが配るのはアプリ本体だけで、
    // 記事の画像は必ず外から来る。同一オリジンの画像（アイコン）まで image に
    // 落とすと、記事の画像の LRU に混ざって押し出される
    return facts.destination === 'image' ? 'image' : 'bypass';
  }

  // **ナビゲーション判定より先に見る。** `<a href="/api/opml">` を踏むのは
  // ナビゲーション要求なので（wrangler.jsonc の run_worker_first と同じ話）、
  // 順番を逆にすると書き出した OPML がアプリシェルとして控えられ、
  // 次のオフライン起動で画面の代わりに OPML が出る
  if (url.pathname.startsWith('/api/')) {
    return CACHEABLE_API.has(url.pathname) ? 'api' : 'bypass';
  }
  // Vite が出す /assets/index-<hash>.js は中身が変わらない。取りに行く必要が無い
  if (url.pathname.startsWith('/assets/')) return 'asset';

  // ナビゲーションはアプリシェルから出す。ただし**拡張子の付いたパスは除く**。
  // /manifest.json や /icon-192.png をアドレス欄から直接開くのもナビゲーション要求で、
  // シェル扱いにするとその中身が index.html の代わりに控えられる（/api/opml と同じ罠）。
  // この画面はパスを持たない（どのパスで開いても同じ HTML）ので、除いて困るものは無い
  if (facts.mode === 'navigate') return FILE_PATH.test(url.pathname) ? 'static' : 'shell';
  return 'static';
}

/**
 * 上限を超えた分を、古い順に返す。
 *
 * Cache API の keys() は**入れた順**に返る。参照したものを入れ直せば、この順序が
 * そのまま「最後に使った順」になり、先頭から捨てるだけで LRU になる。
 */
export function overflowing<T>(keys: readonly T[], limit: number): T[] {
  if (keys.length <= limit) return [];
  return keys.slice(0, keys.length - limit);
}
