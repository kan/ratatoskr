import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { getBootstrap, getEntries } from '@/lib/api';
import type { BootstrapResponse } from '@shared/types';
import { loadSnapshot, putFeeds, saveCursor, saveEntries, saveFeeds } from '@/lib/db';
import { useEntriesStore } from './entries';
import { sortByReadingOrder, useFeedsStore } from './feeds';

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

  /** hydrated 以降は操作可能。ready は背景取得まで終わった状態 */
  const phase = ref<'booting' | 'hydrated' | 'ready'>('booting');
  const error = ref<string | null>(null);
  /** サーバが持つ最大 entry id。M4 の GET /api/sync のカーソルになる */
  const entryCursor = ref(0);
  const syncedAt = ref(0);

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
    persistLocalReads();

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
    const snapshot = await loadSnapshot();
    entriesStore.ingest(snapshot.entries);
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
   * ローカルの既読（read_seq の前進）を IndexedDB に書き戻す。
   * これをしないと再読み込みで読んだ記事がまた出てくる。
   * サーバへの送信は M4 の outbox が担当する。
   */
  function persistLocalReads(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 直近で書き戻した read_seq。差分だけを書くために覚えておく
    const saved = new Map<number, number>();

    const flush = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;

      const changed = feedsStore.feeds.filter((feed) => saved.get(feed.id) !== feed.readSeq);
      if (changed.length === 0) return;
      for (const feed of changed) saved.set(feed.id, feed.readSeq);
      void putFeeds(changed);
    };

    // 既読が進んだことだけを見る。全フィードを走査して差分を探すと、
    // 記事を送るたびに購読数ぶんの走査が走る
    watch(
      () => feedsStore.readRevision,
      () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, PERSIST_DELAY);
      },
    );

    // 最終記事を読んだ直後にタブを閉じても取りこぼさない。
    // pagehide だけだと破棄が間に合わないことがあるので、先に来る visibilitychange でも流す
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  return { phase, error, entryCursor, syncedAt, boot };
});
