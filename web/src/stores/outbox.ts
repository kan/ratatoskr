import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ReadMark } from '@shared/types';
import {
  ApiError,
  beaconRead,
  deletePin,
  postPin,
  postRead,
  sendEntryUnread,
  updateFeed,
} from '@/lib/api';
import { deleteOutboxItems, loadOutbox, putOutboxItem } from '@/lib/db';
import { usePinsStore } from './pins';

/**
 * 書き込みの送信キュー（CLAUDE.md の不変条件 3、docs/DESIGN.md §6）。
 *
 * 既読・未読戻しはローカルに即時反映され、ここに積まれる。UI はサーバの応答を
 * **待たない**。積まれたものは IndexedDB に永続化されるので、オフラインで読んでも
 * タブを閉じても失われず、次に繋がったときに送られる。
 *
 * 送信は全て冪等（既読は MAX、未読戻しは行の有無）。重複しても順序が入れ替わっても
 * 結果が変わらないので、失敗したら同じものをそのまま再送してよい。
 */

export type OutboxItem =
  | { key: string; kind: 'read'; feedId: number; watermark: number }
  | { key: string; kind: 'unread'; entryId: number; unread: boolean }
  | { key: string; kind: 'rate'; feedId: number; rate: number }
  | { key: string; kind: 'pin'; entryId: number | null; title: string; url: string }
  | { key: string; kind: 'unpin'; pinId: number };

/** 積んでから送るまでの待ち。j 連打で 1 記事ごとに POST が飛ぶのを防ぐ */
const FLUSH_DELAY = 2_000;
/** 失敗時のバックオフ。2 秒から倍々で 1 分まで */
const RETRY_BASE = 2_000;
const RETRY_MAX = 60_000;

/** 同じ対象への操作は 1 件にまとめる。既読はフィード単位、未読戻しは記事単位 */
function readKey(feedId: number): string {
  return `read:${feedId}`;
}

function unreadKey(entryId: number): string {
  return `unread:${entryId}`;
}

function rateKey(feedId: number): string {
  return `rate:${feedId}`;
}

/** ピンは URL で 1 件（サーバの UNIQUE と同じ単位）。外すのは id を持っている場合だけ */
function pinKey(url: string): string {
  return `pin:${url}`;
}

function unpinKey(pinId: number): string {
  return `unpin:${pinId}`;
}

/**
 * 送り直しても通らないエラーか。記事が保持期間を過ぎて消えた後の未読戻し（404）や
 * 壊れたリクエスト（400）を延々と再送すると、その後ろの既読まで送れなくなる。
 * 認証切れ（401 / 403）と 429 は時間を置けば通るので落とさない。
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

export const useOutboxStore = defineStore('outbox', () => {
  const pinsStore = usePinsStore();

  /** key → 送信待ちの操作。同じ key への積み増しは上書きになる */
  const items = ref(new Map<string, OutboxItem>());
  const pending = computed(() => items.value.size);

  /** 送信中は次の吐き出しを始めない。応答を待つ間に同じものを二重に送らないため */
  let sending = false;
  /** いま送信中の key。送信中のピンは取り消せない（サーバに出来てしまうため） */
  const inFlight = new Set<string>();
  /** 送信中に外されたピンの url。id が判った時点で改めて外す */
  const cancelled = new Set<string>();
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 送信を予約する。既に予約があるときは**後ろにずらさない**。ずらすと、読み続けて
   * いる間じゅう送信が先送りされ（j を押すたびに 2 秒先へ逃げる）、いつまでも
   * サーバに届かない。まとめる目的は「予約から発火までの窓」で足りる。
   *
   * delay 0 は離脱・復帰時の即時送信なので、予約中でも置き換えて先に走らせる。
   */
  function schedule(delay: number): void {
    if (timer !== null) {
      if (delay > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  }

  function enqueue(item: OutboxItem): void {
    items.value.set(item.key, item);
    // 永続化の完了は待たない。UI はサーバどころか IndexedDB も待たせない
    void putOutboxItem(item);
    schedule(FLUSH_DELAY);
  }

  /**
   * 既読ウォーターマーク。手元の値が単調増加である以上、キューの中でも
   * 前進しかさせない（後から古い値で上書きすると既読が巻き戻る）。
   */
  function queueRead(feedId: number, watermark: number): void {
    const key = readKey(feedId);
    const existing = items.value.get(key);
    if (existing?.kind === 'read' && existing.watermark >= watermark) return;
    enqueue({ key, kind: 'read', feedId, watermark });
  }

  /** 未読に戻す / 戻したものを既読にする。同じ記事への操作は最後のものだけが残る */
  function queueUnread(entryId: number, unread: boolean): void {
    enqueue({ key: unreadKey(entryId), kind: 'unread', entryId, unread });
  }

  /**
   * レート変更（1–5 キー）。読んでいる最中に押されるので outbox 経由にする
   * （CLAUDE.md の不変条件 3）。同じフィードへの連打は最後の値だけが残る。
   */
  function queueRate(feedId: number, rate: number): void {
    enqueue({ key: rateKey(feedId), kind: 'rate', feedId, rate });
  }

  /**
   * ピンを付ける。
   *
   * 送信が通るとサーバが id を振る。外すには id が要るので、応答を手元のピンに
   * 書き戻す（送信結果を使う唯一の操作）。
   */
  function queuePin(entryId: number | null, title: string, url: string): void {
    enqueue({ key: pinKey(url), kind: 'pin', entryId, title, url });
  }

  /**
   * ピンを外す。
   *
   * まだ送っていない追加が残っていれば、それを取り消すだけでよい（サーバはまだ知らない）。
   * ただし**送信中のものは取り消せない**。応答が返ればサーバにはピンが出来ているので、
   * 取り消したつもりで消し忘れると、次の bootstrap で復活する。
   * その場合は id が判ってから改めて外す（cancelled に控えておく）。
   *
   * @returns サーバへ送る必要があったか
   */
  function queueUnpin(pinId: number, url: string): boolean {
    const key = pinKey(url);
    const queued = items.value.get(key);

    if (queued !== undefined && pinId < 0) {
      if (inFlight.has(key)) {
        cancelled.add(url);
        return true;
      }
      items.value.delete(key);
      void deleteOutboxItems([key]);
      return false;
    }
    enqueue({ key: unpinKey(pinId), kind: 'unpin', pinId });
    return true;
  }

  /**
   * 1 回の吐き出しで送る単位。既読はまとめて 1 リクエスト、未読戻しとレートは対象ごと。
   * marks が付いているものだけが sendBeacon に載せられる（離脱時の経路）。
   */
  interface Send {
    keys: string[];
    run: () => Promise<unknown>;
    marks?: ReadMark[];
  }

  function plan(batch: OutboxItem[]): Send[] {
    const sends: Send[] = [];

    const reads = batch.filter((item) => item.kind === 'read');
    if (reads.length > 0) {
      const marks: ReadMark[] = reads.map((item) => ({
        feedId: item.feedId,
        watermark: item.watermark,
      }));
      sends.push({ keys: reads.map((item) => item.key), run: () => postRead(marks), marks });
    }

    for (const item of batch) {
      if (item.kind === 'unread') {
        sends.push({ keys: [item.key], run: () => sendEntryUnread(item.entryId, item.unread) });
      } else if (item.kind === 'rate') {
        sends.push({ keys: [item.key], run: () => updateFeed(item.feedId, { rate: item.rate }) });
      } else if (item.kind === 'pin') {
        sends.push({
          keys: [item.key],
          // 応答の id と見出しを手元に書き戻す。id が無いとそのピンを外せない
          run: () =>
            postPin({ entryId: item.entryId, title: item.title, url: item.url }).then((body) => {
              pinsStore.confirm(item.url, body.pin);
              // 送信中に外されていた。サーバには出来てしまったので、改めて外す
              if (cancelled.delete(item.url)) queueUnpin(body.pin.id, item.url);
            }),
        });
      } else if (item.kind === 'unpin') {
        sends.push({ keys: [item.key], run: () => deletePin(item.pinId) });
      }
    }
    return sends;
  }

  /**
   * 送信が済んだ分をキューから落とす。
   *
   * 送信中に同じ key へ積み増しがあった場合は、オブジェクトが差し替わっているので
   * 消さずに残す（そのまま消すと、送った後に進んだ既読が失われる）。
   */
  async function settle(sent: OutboxItem[]): Promise<void> {
    const removed: string[] = [];
    for (const item of sent) {
      if (items.value.get(item.key) !== item) continue;
      items.value.delete(item.key);
      removed.push(item.key);
    }
    try {
      await deleteOutboxItems(removed);
    } catch (err) {
      // 消し損ねても、残った行は次の起動で再送されるだけ（冪等）。送信は成功している
      console.error('outbox の後始末に失敗', err);
    }
  }

  /**
   * キューを吐き出す。
   *
   * **送信済みの印はリクエストを発行する前に立てる。** 応答を受けてから立てると、
   * 送信中に離脱・復帰したときに同じものをもう一度送ってしまう（LDRoid が踏んだバグ。
   * docs/DESIGN.md §6）。ここでは sending がその印にあたる。
   *
   * 永続化された行を消すのは応答を受けてから。送信中に落ちても失われず、
   * 二重に届いても冪等なので害が無い、という順序にしてある。
   */
  async function flush(): Promise<void> {
    if (sending) return;
    const batch = [...items.value.values()];
    if (batch.length === 0) return;

    sending = true;
    let failed = false;
    for (const item of batch) inFlight.add(item.key);
    try {
      const sends = plan(batch);
      const results = await Promise.allSettled(sends.map((send) => send.run()));

      const sentKeys = new Set<string>();
      results.forEach((result, index) => {
        // 送り直しても通らないものは、成功と同じ扱いでキューから落とす
        if (result.status === 'fulfilled' || isPermanent(result.reason)) {
          for (const key of sends[index].keys) sentKeys.add(key);
          return;
        }
        failed = true;
        console.error('outbox の送信に失敗', result.reason);
      });
      await settle(batch.filter((item) => sentKeys.has(item.key)));
    } finally {
      inFlight.clear();
      sending = false;
    }

    if (failed) {
      failures += 1;
      // 指数バックオフ。繋がらない間ずっと最短間隔で叩き続けない
      schedule(Math.min(RETRY_BASE * 2 ** (failures - 1), RETRY_MAX));
    } else {
      failures = 0;
      // 送信中に積まれた分があれば続けて送る
      if (items.value.size > 0) schedule(FLUSH_DELAY);
    }
  }

  /**
   * 送信待ちのレート。サーバのフィード一覧を当てるときに、まだ届いていない
   * 変更をこちらの値で上書きし直すために使う（stores/session.ts）。
   */
  function pendingRates(): Map<number, number> {
    const rates = new Map<number, number>();
    for (const item of items.value.values()) {
      if (item.kind === 'rate') rates.set(item.feedId, item.rate);
    }
    return rates;
  }

  /**
   * ページ破棄の直前。fetch は取り消されることがあるので、既読は sendBeacon に委ねる。
   *
   * 未読戻しとレート変更は対象ごとに URL とメソッドが違い、sendBeacon に載らない
   * （POST 固定・ボディだけしか送れない）ので、keepalive 付きの fetch で投げる。
   * 取り消される可能性は残るが、何も送らなければ確実に失われる。
   *
   * どれも応答は当てにできないのでキューからは落とさない
   * （次の起動で再送される。冪等なので二重に届いても害が無い）。
   */
  function flushOnUnload(): void {
    const marks: ReadMark[] = [];
    for (const send of plan([...items.value.values()])) {
      if (send.marks !== undefined) marks.push(...send.marks);
      else void send.run().catch(() => undefined);
    }
    if (marks.length > 0) beaconRead(marks);
  }

  /**
   * 前回の起動で送り切れなかった分を読み戻して送る。起動時に 1 回だけ呼ぶ。
   * オフラインで読んだ分がここから届く。
   */
  async function hydrate(): Promise<void> {
    try {
      for (const item of await loadOutbox()) {
        // 起動直後に積まれた分の方が新しい。読み戻しで上書きしない
        if (!items.value.has(item.key)) items.value.set(item.key, item);
      }
    } catch (err) {
      // 読めなくても、この起動で積まれる分は送れる。ここで止まらない
      console.error('outbox の読み出しに失敗', err);
    }
    if (items.value.size > 0) schedule(0);
  }

  /**
   * 送信の契機を張る。読み戻しと分けてあるのは、離脱時の順序を確実にするため
   * （手元の変化を積む側より後に登録する必要がある。stores/session.ts）。
   */
  function install(): void {
    // 復帰したらすぐ送る。バックオフの途中でも待たせない
    window.addEventListener('online', () => {
      failures = 0;
      schedule(0);
    });
    // タブを離れる時点で送っておく。戻ってこないまま閉じられることがある
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') schedule(0);
    });
    window.addEventListener('pagehide', flushOnUnload);
  }

  return {
    items,
    pending,
    queueRead,
    queueUnread,
    queueRate,
    queuePin,
    queueUnpin,
    pendingRates,
    flush,
    flushOnUnload,
    hydrate,
    install,
  };
});
