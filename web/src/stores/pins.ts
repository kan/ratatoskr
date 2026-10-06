import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Entry, Pin } from '@shared/types';
import { useNsfwStore } from './nsfw';

/**
 * ピン（docs/UX.md「ピン」）。
 *
 * 「読む」と「後で処理する」を分けるための置き場。既読とは独立していて、
 * ピンしても記事は既読化の対象から外れない。
 *
 * サーバへの送信は outbox が行う（不変条件 3）。ここは手元の状態だけを持ち、
 * 追加した瞬間に一覧へ出す。サーバの id は送信が通ってから埋まる。
 */

/**
 * 送信が通るまでの仮の id。負の値にして、サーバの id と取り違えないようにする。
 *
 * **手元での同一性は id ではなく url。** 仮 id はリロードで採番が巻き戻るので、
 * id で消すと別のピンを巻き添えにする。url はサーバの UNIQUE と同じ単位で、
 * 採番に依存しない。
 */
let nextLocalId = -1;

export const usePinsStore = defineStore('pins', () => {
  const nsfw = useNsfwStore();

  /** 新しい順。サーバの並び（pinned_at 降順）と同じ */
  const pins = ref<Pin[]>([]);

  /** 中身が変わるたびに増える。手元への書き戻し（session）がこれを見て走る */
  const revision = ref(0);

  /**
   * この端末で出すピン（issue #23）。NSFW のフィードの記事に立てたピンは、表示を
   * 有効にした端末でしか出さない。**画面に出すものは全てこちらを通す**（一覧、件数、
   * 「全て開く」）。`pins` は手元への書き戻しと重複の判定のために全件を持つ
   */
  const shown = computed(() => nsfw.shownOf(pins.value));

  const count = computed(() => shown.value.length);

  /**
   * 全てのピンの url の集合。**隠しているピンも含む。** 手元の記事の間引き
   * （lib/retention.ts）が引くので、出していないからといって無いことにはできない
   */
  const urls = computed(() => new Set(pins.value.map((pin) => pin.url)));

  /**
   * 画面に出ているピンの url の集合。左ペインが 1 行ごとに引くので、毎回作り直さず
   * computed に載せる。有無の判定もこれを通す（線形探索を残すと、記事送りのたびに
   * 全件を舐めることになる）。隠すピンが無ければ `urls` をそのまま使い回す
   */
  const shownUrls = computed(() =>
    shown.value === pins.value ? urls.value : new Set(shown.value.map((pin) => pin.url)),
  );

  /**
   * ピンの url はサーバが new URL().href で正規化して返す。手元でも同じ形にしないと、
   * bootstrap で受け取った後に同じ記事が「別のピン」に見えてしまう
   */
  function normalize(url: string): string {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  }

  /**
   * 画面から見てピンが立っているか。**隠しているピンは「立っていない」と答える。**
   * 同じ URL を NSFW のフィードと普通のフィードの両方が配ることがあり、立っていると
   * 答えると、隠している端末で p を押したときに見えていないピンを外してしまう
   */
  function has(url: string): boolean {
    return shownUrls.value.has(normalize(url));
  }

  /** 隠しているピンも含めて探す。送信結果の書き戻しなど、手元の整合のために使う */
  function find(url: string): Pin | undefined {
    const normalized = normalize(url);
    return pins.value.find((pin) => pin.url === normalized);
  }

  /** 画面に出ているピンから探す。外す操作（p）はこちらを通す。理由は has と同じ */
  function findShown(url: string): Pin | undefined {
    const pin = find(url);
    return pin === undefined || nsfw.isHidden(pin) ? undefined : pin;
  }

  /**
   * サーバから来た一覧で置き換える。まだ送信が通っていないピン（負の id）は残す。
   * 消すと、追加した直後に bootstrap が返ってきただけで一覧から消える
   */
  function setPins(next: Pin[]): void {
    const pending = pins.value.filter((pin) => pin.id < 0 && !next.some((p) => p.url === pin.url));
    pins.value = [...pending, ...next];

    // 仮 id の採番を、いま手元にあるものより下から続ける。
    // リロードのたびに -1 へ戻すと、復元した未送信のピンと衝突する
    for (const pin of pins.value) nextLocalId = Math.min(nextLocalId, pin.id - 1);
    revision.value += 1;
  }

  /**
   * 手元に足す。既にあれば何もしない（同じ URL は 1 件）。
   *
   * `marked` は記事のフィードの NSFW の印。サーバも同じものを記事から引いて控えるが
   * （src/db/pins.ts）、送信が通るまで待つと、ピンした直後に表示を切った端末で
   * 一覧に残る。
   *
   * **隠しているピンと同じ URL なら、立て直す。** 見えている記事に立てたのだから、
   * そのピンは見えるものになる（サーバも INSERT OR REPLACE で同じ記事から印を
   * 引き直す）。「既にある」として何もしないと、p を押しても何も起きない
   */
  function add(entry: Entry, now: number, marked = false): Pin | null {
    if (entry.url === null || has(entry.url)) return null;

    const pin: Pin = {
      id: nextLocalId,
      entryId: entry.id,
      title: entry.title,
      url: normalize(entry.url),
      pinnedAt: now,
      nsfw: marked,
    };
    nextLocalId -= 1;
    pins.value = [pin, ...pins.value.filter((other) => other.url !== pin.url)];
    revision.value += 1;
    return pin;
  }

  /** 消すのは url で行う。仮 id は起動をまたぐと信用できない */
  function remove(url: string): void {
    const normalized = normalize(url);
    pins.value = pins.value.filter((pin) => pin.url !== normalized);
    revision.value += 1;
  }

  /**
   * 送信が通った。サーバが振った id と、サーバが控えた見出しに差し替える。
   *
   * 見出しまで受け直すのは、**タイトルを配らないフィードの記事では、サーバが本文の
   * 書き出しから作った見出しが返ってくる**ため（src/api/pins.ts）。手元の空のままに
   * すると、次に bootstrap を受けるまで一覧に URL が並ぶ。
   */
  function confirm(url: string, saved: Pin): void {
    const pin = find(url);
    if (pin === undefined) return;
    pin.id = saved.id;
    pin.title = saved.title;
    pin.nsfw = saved.nsfw;
    revision.value += 1;
  }

  /**
   * フィードの NSFW の印を変えたとき、その記事に立てたピンにも当てる。
   *
   * サーバは同じことを設定の更新と一緒に済ませている（src/db/feeds.ts）。次の同期で
   * 届くが、それを待つと、印を付けたフィードは消えたのにピンだけ一覧に残る
   */
  function setNsfwByEntries(entryIds: ReadonlySet<number>, marked: boolean): void {
    let changed = false;
    for (const pin of pins.value) {
      if (pin.entryId === null || !entryIds.has(pin.entryId) || pin.nsfw === marked) continue;
      pin.nsfw = marked;
      changed = true;
    }
    if (changed) revision.value += 1;
  }

  return {
    pins,
    shown,
    count,
    urls,
    shownUrls,
    revision,
    has,
    find,
    findShown,
    setPins,
    add,
    remove,
    confirm,
    setNsfwByEntries,
  };
});
