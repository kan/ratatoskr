import { isCacheableImageUrl, openImageCache } from '@/lib/prefetch';
import { IMAGE_CACHE, PREFETCH_IMAGE_CACHE } from '@/lib/sw-policy';

/**
 * 読めなかった画像を、控えを取り直して読み直す
 * （docs/DESIGN.md §6「先読みは成否を判定できない」）。
 *
 * 判定がここにあるのは、opaque の応答からは成否が読めず、**画像として使えたかを
 * 知れるのが本文の `<img>` だけ**だから。先読みにも Service Worker にも観測点が無い。
 *
 * **本文を `v-html` で描く箇所には `@error.capture` を付けること。** 修復はそこから
 * しか起動しない（いまは components/EntryReader.vue の 1 箇所）。付け忘れると、
 * 特定の端末でだけ画像が永久に出なくなる（報告も再現もされにくい壊れ方）。
 */

export interface RepairDeps {
  fetchImpl?: typeof fetch;
  /** null を返せば Cache API に触らず、HTTP キャッシュの入れ替えだけを行う */
  openCache?: (name: string) => Promise<Cache | null>;
}

/** 画像の控えが置かれる場所。先読みの分と Service Worker の分の両方を落とす */
const IMAGE_CACHES: readonly string[] = [PREFETCH_IMAGE_CACHE, IMAGE_CACHE];

export interface ImageRepairer {
  repair(img: HTMLImageElement): Promise<void>;
}

export function createImageRepairer(deps: RepairDeps = {}): ImageRepairer {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openCache = deps.openCache ?? openImageCache;
  /** URL ごとの取り直し。1 つの記事が同じ画像を何度も使うので束ねる */
  const refreshing = new Map<string, Promise<boolean>>();
  /** 読み直しを試した img。「読めない → 読み直す」の輪に入らないための歯止め */
  const retried = new WeakSet<HTMLImageElement>();

  async function repair(img: HTMLImageElement): Promise<void> {
    const url = img.src;
    if (!isCacheableImageUrl(url)) return;

    if (retried.has(img)) {
      // 取り直した後でまた読めなかった。遮断されている等こちらでは直せないので、
      // 以後この URL では読み直しを試さない（記事を開き直すたびに要求を捨てないため）
      refreshing.set(url, Promise.resolve(false));
      return;
    }
    retried.add(img);

    let refresh = refreshing.get(url);
    if (refresh === undefined) {
      refresh = refetch(url);
      refreshing.set(url, refresh);
    }
    if (await refresh) img.src = url;
  }

  /**
   * 壊れた控えを、取り直したもので置き換える。
   *
   * **取り直してから消す。** 先に消すと、取り直せなかったとき（圏外・遮断）に
   * オフライン用の写しまで道連れにする。遮断されているだけなら控えの中身は無事。
   *
   * ここの `fetch` は Service Worker に握られない。`routeFor` が cross-origin の
   * 非 image destination を bypass に落としていて、素の `fetch` の destination は
   * 空文字だから（lib/sw-policy.ts）。**握られると cache-first の同じ壊れた応答が
   * 返り、修復が成功したまま何も変わらなくなる。**
   *
   * @returns 取り直せたか。false なら読み直しても同じ結果になる
   */
  async function refetch(url: string): Promise<boolean> {
    try {
      // HTTP キャッシュごと入れ替える。Cache API から落としただけだと、
      // 読み直しがそちらに残った同じ壊れた応答から返ってくる
      await fetchImpl(url, { mode: 'no-cors', credentials: 'omit', cache: 'reload' });
    } catch {
      return false;
    }
    await dropFromCaches(url);
    return true;
  }

  async function dropFromCaches(url: string): Promise<void> {
    await Promise.all(
      IMAGE_CACHES.map(async (name) => {
        const cache = await openCache(name);
        try {
          await cache?.delete(url);
        } catch {
          // 消せなくても、HTTP キャッシュの入れ替えだけは効く
        }
      }),
    );
  }

  return { repair };
}

let shared: ImageRepairer | null = null;

/** 表示側（components/EntryReader.vue）から呼ぶ入口 */
export function repairBrokenImage(img: HTMLImageElement): void {
  shared ??= createImageRepairer();
  void shared.repair(img);
}
