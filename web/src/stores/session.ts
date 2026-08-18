import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { getBootstrap, getEntries } from '@/lib/api';
import type { BootstrapResponse } from '@shared/types';
import {
  deleteEntryState,
  loadEntryStates,
  loadSnapshot,
  putEntryState,
  putFeeds,
  saveCursor,
  saveEntries,
  saveFeeds,
} from '@/lib/db';
import { useEntriesStore } from './entries';
import { sortByReadingOrder, useFeedsStore } from './feeds';
import { useOutboxStore } from './outbox';

/**
 * 起動シーケンス（docs/DESIGN.md §6）。
 *
 *   1. IndexedDB から前回の状態を読んで即座に描画（オフラインでも起動する）
 *   2. GET /api/bootstrap で上位フィードの本文まで取る
 *   3. 背景で GET /api/entries を回して残りを埋める
 *
 * 2 以降が失敗しても 1 の状態で操作できることが要件。逆に 1 が失敗しても
 * 2 以降だけで起動できること（手元のキャッシュはあくまで速さのための手段）。
 */

/** 残りの記事を引くときの 1 ページの件数 */
const PAGE_SIZE = 500;
/** ローカルの既読を書き戻すまでの待ち（連打で書き込みが増えるのを防ぐ） */
const PERSIST_DELAY = 500;

export const useSessionStore = defineStore('session', () => {
  const feedsStore = useFeedsStore();
  const entriesStore = useEntriesStore();
  const outbox = useOutboxStore();

  /** hydrated 以降は操作可能。ready は背景取得まで終わった状態 */
  const phase = ref<'booting' | 'hydrated' | 'ready'>('booting');
  const error = ref<string | null>(null);
  /** サーバが持つ最大 entry id。M4 の GET /api/sync のカーソルになる */
  const entryCursor = ref(0);
  const syncedAt = ref(0);

  /**
   * 手元（IndexedDB）に保存済みの状態。差分の起点になる。
   *
   * **読み出した直後に控える。** 起動シーケンスの中で最初の記事を表示した時点で既読は
   * 進み、未読に戻していた記事の例外も外れる。後から控えると、その変化が「無かったこと」
   * になって書き戻しも送信もされない。
   */
  const persisted = { readSeq: new Map<number, number>(), forcedUnread: new Set<number>() };

  async function boot(): Promise<void> {
    // 手元の読み出しとネットワークは互いに依存しない。往復を待たせないよう先に投げる。
    // await するまでの間に失敗しても未処理拒否にならないようにしておく
    const bootstrapping = getBootstrap();
    bootstrapping.catch(() => undefined);

    try {
      await hydrate();
    } catch (err) {
      // 手元のキャッシュが読めなくてもサーバから取り直せる。ここで止まらない
      console.error('ローカルの読み出しに失敗', err);
      phase.value = 'hydrated';
    }
    // 送信の契機は persistLocalState より後に張る。離脱時は「手元の変化を積む → 送る」
    // の順でなければ、最後に読んだ分が送られない
    persistLocalState();
    outbox.install();
    // 前回送り切れなかった分の再送。完了は待たずに読み始められる
    void outbox.hydrate();

    try {
      await applyBootstrap(await bootstrapping);
      await fillRemaining();
      feedsStore.recountUnread();
      phase.value = 'ready';
    } catch (err) {
      // 手元のデータで操作は続けられる。失敗はヘッダに出すだけに留める
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function hydrate(): Promise<void> {
    const [snapshot, forcedUnread] = await Promise.all([loadSnapshot(), loadEntryStates()]);
    for (const feed of snapshot.feeds) persisted.readSeq.set(feed.id, feed.readSeq);
    for (const entryId of forcedUnread) persisted.forcedUnread.add(entryId);

    entriesStore.ingest(snapshot.entries);
    // 未読に戻した記事はサーバから復元できない。手元の記録がそのまま正
    entriesStore.restoreForcedUnread(forcedUnread);
    // IndexedDB は id 順で返ってくる。読む順序に並べ直してから渡す
    feedsStore.setFeeds(sortByReadingOrder(snapshot.feeds));
    feedsStore.enterFirstUnread();
    entryCursor.value = snapshot.entryCursor;
    syncedAt.value = snapshot.syncedAt;
    phase.value = 'hydrated';
  }

  async function applyBootstrap(body: BootstrapResponse): Promise<void> {
    entriesStore.ingest(body.entries);
    feedsStore.setFeeds(body.feeds);
    if (!feedsStore.started) feedsStore.enterFirstUnread();
    else feedsStore.absorbNewEntries();

    entryCursor.value = body.maxEntryId;
    syncedAt.value = body.serverTime;
    error.value = null;

    await Promise.all([
      saveFeeds(feedsStore.feeds),
      saveEntries(body.entries),
      saveCursor(body.maxEntryId, body.serverTime),
    ]);
  }

  /** 残りの未読記事を sinceId ページングで全部落とす。ここが終われば以降は完全にローカル操作 */
  async function fillRemaining(): Promise<void> {
    let sinceId = 0;
    // 保存の完了は次ページの取得を待たせない。書き込み同士の順序だけ保つ
    let saved: Promise<void> = Promise.resolve();

    for (;;) {
      const page = await getEntries({ sinceId, limit: PAGE_SIZE, unreadOnly: true });
      entriesStore.ingest(page.entries);
      // 読んでいる最中のフィードに届いた分はその場でリストに足す。
      // これをしないと、表示しないまま既読になる記事が出る
      feedsStore.absorbNewEntries();
      saved = saved.then(() => saveEntries(page.entries));

      if (!page.hasMore || page.nextSinceId === null) {
        await saved;
        return;
      }
      sinceId = page.nextSinceId;
    }
  }

  /**
   * ローカルの既読を手元（IndexedDB）に書き戻し、サーバへの送信キューに積む。
   *
   * 書き戻しをしないと再読み込みで読んだ記事がまた出てくる。積まないと他の端末に
   * 伝わらない。どちらも「何が変わったか」を同じ差分から出すので 1 箇所にまとめる。
   */
  function persistLocalState(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 保存済みの状態を起点に差分を出す。手元が読めなかった場合は空のまま始まり、
    // 最初の 1 回で全件を書き戻す（多いのは初回だけなので許容する）
    const savedReadSeq = persisted.readSeq;
    const savedUnread = persisted.forcedUnread;

    /** 進んだ既読。フィード単位なので、変わった行だけをまとめて書く */
    const flushReads = (): void => {
      const changed = feedsStore.feeds.filter((feed) => savedReadSeq.get(feed.id) !== feed.readSeq);
      if (changed.length === 0) return;
      for (const feed of changed) {
        savedReadSeq.set(feed.id, feed.readSeq);
        outbox.queueRead(feed.id, feed.readSeq);
      }
      void putFeeds(changed);
    };

    /** 未読に戻した記事の増減。例外は基本ゼロ件なので、両方空なら走査ごと省く */
    const flushUnread = (): void => {
      if (savedUnread.size === 0 && entriesStore.forcedUnread.size === 0) return;

      for (const entryId of entriesStore.forcedUnread) {
        if (savedUnread.has(entryId)) continue;
        savedUnread.add(entryId);
        void putEntryState(entryId);
        outbox.queueUnread(entryId, true);
      }
      // 削除しながら回るので複製を辿る
      for (const entryId of [...savedUnread]) {
        if (entriesStore.forcedUnread.has(entryId)) continue;
        savedUnread.delete(entryId);
        void deleteEntryState(entryId);
        outbox.queueUnread(entryId, false);
      }
    };

    const flush = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      flushReads();
      flushUnread();
    };

    // 既読が進んだこと・未読に戻したことだけを見る。全フィードを走査して差分を探すと、
    // 記事を送るたびに購読数ぶんの走査が走る
    watch(
      () => [feedsStore.readRevision, entriesStore.unreadRevision],
      () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, PERSIST_DELAY);
      },
    );

    // 起動シーケンスの中で進んだ分（最初の記事の表示）を先に片付ける。
    // watch は「以降の変化」しか見ないので、これが無いと手元を読み直しただけの起動で
    // 表示した記事が書き戻しも送信もされない
    flush();

    // 最終記事を読んだ直後にタブを閉じても取りこぼさない。
    // pagehide だけだと破棄が間に合わないことがあるので、先に来る visibilitychange でも流す。
    // outbox も同じ契機で送信する。ここで積んだ分をそちらが拾えるよう、先に登録しておく
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  return { phase, error, entryCursor, syncedAt, boot };
});
