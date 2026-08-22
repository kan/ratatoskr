import {
  API_CACHE,
  ASSET_CACHE,
  CACHE_PREFIX,
  IMAGE_CACHE,
  IMAGE_LIMIT,
  LIVE_CACHES,
  PREFETCH_IMAGE_CACHE,
  SHELL_CACHE,
  SHELL_URL,
  overflowing,
  routeFor,
} from '@/lib/sw-policy';

/**
 * Service Worker（docs/DESIGN.md §8）。
 *
 * 役割は 2 つだけ。
 *   1. オフラインでも起動できること（アプリシェルと bootstrap の控え）
 *   2. 先読みした画像をオフラインでも出せること（Cache API を読むのは SW だけ）
 *
 * **API はネットワーク優先にしてある。** 繋がっていれば必ず最新を返し、繋がらない
 * ときだけ控えを出す。stale-while-revalidate にすると、クライアントは応答を 1 回しか
 * 読まないので新着が常に 1 周遅れる（起動の速さは IndexedDB からの即描画で
 * 既に確保されていて、ここで稼ぐものが無い）。
 *
 * 書き込みには一切触らない。既読・ピンの送信は離脱後も届くことを当てにしている
 * 経路なので、間に入らない（CLAUDE.md の不変条件 3）。
 */

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precache();
      // 古い版を残しても得が無い。次の起動を待たせずに差し替える
      await sw.skipWaiting();
    })(),
  );
});

/** index.html が参照するハッシュ付きの資産。Vite の出力は /assets/ 配下に揃う */
const ASSET_REF = /\/assets\/[A-Za-z0-9._-]+/g;

/**
 * アプリシェルと、それが参照する資産を先に取っておく。
 *
 * **シェルだけでは足りない。** 初回の訪問では Service Worker がまだ要求を握って
 * いないので、js と css は素通りしてキャッシュに残らない。その状態で機内モードに
 * 入られると、HTML だけが出て中身が動かない（実際に踏んだ）。
 *
 * 一覧はビルドの出力そのもの（index.html）から起こす。別立ての manifest を
 * 作る手もあるが、生成を忘れた瞬間に「オフラインだと白い画面」になる。
 * 参照元から引く限り、ハッシュがずれることはない。
 */
async function precache(): Promise<void> {
  const shell = await caches.open(SHELL_CACHE);
  // 取り直す。HTTP キャッシュに残った古い HTML を控えると、参照する資産と食い違う
  const response = await fetch(SHELL_URL, { cache: 'reload' });
  if (!response.ok) return;

  const html = await response.clone().text();
  await put(shell, SHELL_URL, response);

  const referenced = new Set(html.match(ASSET_REF) ?? []);
  const assets = await caches.open(ASSET_CACHE);
  await Promise.all(
    [...referenced].map(async (url) => {
      // 1 つ取れなくてもインストール自体は成功させる。次の要求で取り直せばよい
      try {
        const asset = await fetch(url, { cache: 'reload' });
        if (asset.ok) await put(assets, url, asset);
      } catch {
        // オフラインでの更新など。控えられなかっただけ
      }
    }),
  );

  // 前の版の資産を捨てる。名前にハッシュが入る以上、置き換わることは無いので、
  // ここで落とさないとデプロイのたびに 1 組ずつ積み上がる。
  // 動的 import は使っていない（出力は 1 チャンク）ので、いま開いている画面が
  // 後から古い資産を取りに来ることもない
  await Promise.all(
    (await assets.keys())
      .filter((key) => !referenced.has(new URL(key.url).pathname))
      .map((key) => assets.delete(key)),
  );
}

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // 自分のものだけ触る。先読みのキャッシュ（PREFETCH_IMAGE_CACHE）は
          // LIVE_CACHES に入れてあるので巻き添えにしない
          .filter((name) => name.startsWith(CACHE_PREFIX) && !LIVE_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  const route = routeFor({
    method: request.method,
    url: request.url,
    origin: sw.location.origin,
    destination: request.destination,
    mode: request.mode,
  });

  switch (route) {
    case 'bypass':
      // respondWith を呼ばなければブラウザ既定の経路をそのまま通る
      return;
    case 'shell':
      // どのパスで開いても SPA は同じ HTML なので、控えは 1 つで足りる
      event.respondWith(networkFirst(request, SHELL_CACHE, SHELL_URL));
      return;
    case 'static':
      event.respondWith(networkFirst(request, SHELL_CACHE));
      return;
    case 'api':
      event.respondWith(networkFirst(request, API_CACHE));
      return;
    case 'asset':
      event.respondWith(cacheFirst(request, ASSET_CACHE));
      return;
    case 'image':
      event.respondWith(image(request));
      return;
  }
});

/**
 * ネットワーク優先。繋がらないときだけ控えを出す。
 *
 * 控えるのは 200 番台だけ。認証切れ（Cloudflare Access のログイン誘導）や
 * エラーを手元に焼き付けると、繋がっている間ずっとそれが出続ける。
 */
async function networkFirst(request: Request, cacheName: string, key?: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cacheKey: RequestInfo = key ?? request;

  try {
    const response = await fetch(request);
    if (response.ok) await put(cache, cacheKey, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached !== undefined) return cached;
    throw err;
  }
}

/** 中身が変わらないもの（ハッシュ付きの資産）。手元にあれば取りに行かない */
async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;

  const response = await fetch(request);
  if (response.ok) await put(cache, request, response.clone());
  return response;
}

/**
 * 記事の画像。
 *
 * 先読み（lib/prefetch.ts）が温めたキャッシュを**まず**見る。ウィンドウの中身は
 * あちらが持っていて、こちらが書くと二重に抱えることになるので読むだけにする。
 * ウィンドウから外れて捨てられた分は、こちら側の控えが受け持つ。
 */
async function image(request: Request): Promise<Response> {
  const cache = await caches.open(IMAGE_CACHE);

  const warmed = await caches.match(request, { cacheName: PREFETCH_IMAGE_CACHE });
  if (warmed !== undefined) {
    // **こちらにも写しておく。** 先読みはウィンドウから外れた画像を消すので、
    // 写さないとオフラインで k を押して戻った先の画像が出ない（読み終えた記事の
    // 画像は必ずウィンドウの外にある）
    void store(cache, request, warmed.clone());
    return warmed;
  }

  const cached = await cache.match(request);
  if (cached !== undefined) {
    // 参照したものを入れ直して最後尾へ送る。keys() の順序がそのまま
    // 「最後に使った順」になり、先頭から捨てるだけで LRU になる
    // （put は同じ key の記録を置き換えたうえで末尾に積み直す。実測で確認した）
    void store(cache, request, cached.clone());
    return cached;
  }

  const response = await fetch(request);
  // 記事の画像は別のオリジンから no-cors で来るので opaque（status 0）になる。
  // ok を見るだけだと 1 枚も残らない
  if (response.ok || response.type === 'opaque') void store(cache, request, response.clone());
  return response;
}

/** 画像を控えて、上限を超えた分を古い順に捨てる */
async function store(cache: Cache, request: Request, response: Response): Promise<void> {
  // 先に消してから置かない。置く方が失敗したときに、既に持っていた控えまで失う
  if (!(await put(cache, request, response))) return;

  const keys = await cache.keys();
  await Promise.all(overflowing(keys, IMAGE_LIMIT).map((key) => cache.delete(key)));
}

/**
 * キャッシュへの書き込み。**失敗しても呼び出し元は止めない。**
 * 容量超過や opaque を置けない実装で落ちても、応答そのものは返せている
 *
 * @returns 置けたか
 */
async function put(cache: Cache, key: RequestInfo, response: Response): Promise<boolean> {
  try {
    await cache.put(key, response);
    return true;
  } catch {
    return false;
  }
}
