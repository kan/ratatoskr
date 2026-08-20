import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  createFeed,
  deleteFeed,
  getBootstrap,
  getEntries,
  importOpml,
  refetchFeed,
  updateFeed,
} from '@/lib/api';
import type {
  BootstrapResponse,
  CreateFeedRequest,
  OpmlImportResponse,
  UpdateFeedRequest,
} from '@shared/types';
import {
  deleteEntryState,
  deleteFeedData,
  loadEntryStates,
  onLocalStoreUnavailable,
  loadPins,
  savePins,
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
import { usePinsStore } from './pins';

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
  const pinsStore = usePinsStore();
  const outbox = useOutboxStore();

  /** hydrated 以降は操作可能。ready は背景取得まで終わった状態 */
  const phase = ref<'booting' | 'hydrated' | 'ready'>('booting');
  const error = ref<string | null>(null);
  /**
   * 手元（IndexedDB）が使えない理由。読むだけなら困らないが、既読やピンが
   * 手元にもキューにも残らない状態なので、黙って続けずに画面に出す
   */
  const localError = ref<string | null>(null);
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
  const persisted = {
    readSeq: new Map<number, number>(),
    rate: new Map<number, number>(),
    forcedUnread: new Set<number>(),
    /** 最後に書き戻したピンのリビジョン。変わっていなければ書き直さない */
    pinRevision: 0,
  };

  async function boot(): Promise<void> {
    onLocalStoreUnavailable((reason) => {
      localError.value = reason;
    });

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
    const [snapshot, forcedUnread, pins] = await Promise.all([
      loadSnapshot(),
      loadEntryStates(),
      loadPins(),
    ]);
    pinsStore.setPins(pins);
    persisted.pinRevision = pinsStore.revision;
    for (const feed of snapshot.feeds) {
      persisted.readSeq.set(feed.id, feed.readSeq);
      persisted.rate.set(feed.id, feed.rate);
    }
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
    // サーバの値を当てる前に、手元の未送信分をキューへ出し切る。
    // 出し切ってあれば、当てた後の値をそのまま次の差分の起点にできる
    flushLocalState();

    entriesStore.ingest(body.entries);
    // まだ送信が通っていないピンは残す（setPins の中で url を突き合わせる）
    pinsStore.setPins(body.pins);
    feedsStore.setFeeds(body.feeds);
    // レートはサーバの値をそのまま受けるので、まだ届いていない変更を当て直す
    feedsStore.applyPendingRates(outbox.pendingRates());
    rebasePersisted();

    if (!feedsStore.started) feedsStore.enterFirstUnread();
    else feedsStore.absorbNewEntries();

    entryCursor.value = body.maxEntryId;
    syncedAt.value = body.serverTime;
    error.value = null;

    await Promise.all([
      saveFeeds(feedsStore.feeds),
      saveEntries(body.entries),
      savePins(pinsStore.pins),
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
   * 購読の追加・更新・削除・手動更新（M5）。
   *
   * 既読やレートと違って outbox は通さない。フィードの検出も初回クロールも
   * サーバでしかできず、結果をその場で見せる必要がある（購読管理画面は
   * 応答を待ってよい普通のフォーム UI）。
   */

  /** 追加。フィードが複数見つかった場合は候補を返し、登録はしない */
  async function subscribe(
    params: CreateFeedRequest,
  ): Promise<
    | { kind: 'created' }
    | { kind: 'candidates'; candidates: { url: string; title: string | null }[] }
  > {
    const result = await createFeed(params);
    if (result.kind === 'candidates') return result;

    const { feed, entries } = result.body;
    entriesStore.ingest(entries);
    feedsStore.upsertFeed(feed);
    await Promise.all([putFeeds([feed]), saveEntries(entries)]);
    return { kind: 'created' };
  }

  async function unsubscribe(id: number): Promise<void> {
    await deleteFeed(id);

    // 未読例外は記事とは別のストアに持っている。残すと、もう存在しない記事の
    // 例外を起動のたびに読み戻し続けることになる
    const droppedUnread = feedsStore.dropFeed(id);
    for (const entryId of droppedUnread) persisted.forcedUnread.delete(entryId);

    await Promise.all([
      deleteFeedData(id),
      ...droppedUnread.map((entryId) => deleteEntryState(entryId)),
    ]);
  }

  /**
   * まとめて購読を解除する（購読管理画面の一括解除）。
   *
   * 1 件ずつの DELETE を並べるだけにしてある。専用の API を足しても、途中で失敗
   * したときに「どこまで消えたか」を返す必要があり、結局 1 件ずつと同じ扱いになる。
   * 相手は自分のサーバなので、少しだけ並列にして待ち時間を詰める。
   *
   * @returns 実際に解除できた id
   */
  async function unsubscribeMany(ids: number[]): Promise<number[]> {
    const removed: number[] = [];
    const CONCURRENCY = 4;

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((id) => unsubscribe(id)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') removed.push(chunk[index]);
        else console.error('購読の解除に失敗', chunk[index], result.reason);
      });
    }
    return removed;
  }

  /** 購読管理画面からの設定変更。1–5 キーのレート変更は outbox 経由（別経路） */
  async function editFeed(id: number, params: UpdateFeedRequest): Promise<void> {
    const { feed } = await updateFeed(id, params);
    feedsStore.upsertFeed(feed);
    await putFeeds([feed]);
  }

  /**
   * 手動更新（r キー）。
   *
   * 応答には新着だけでなく、全文取得（M7）で本文が差し替わった記事も入る
   * （docs/API.md）。**「N 件の新着」として数えるのは手元に無かったものだけ。**
   * 全部数えると、新着ゼロのフィードで r を押しただけで「10 件の新着」と出る。
   */
  async function refresh(id: number): Promise<number> {
    const { feed, entries } = await refetchFeed(id);
    const known = new Set(entriesStore.of(id).map((entry) => entry.id));
    const added = entries.filter((entry) => !known.has(entry.id)).length;

    entriesStore.ingest(entries);
    feedsStore.applyFetched(feed);
    await Promise.all([putFeeds([feed]), saveEntries(entries)]);
    return added;
  }

  /**
   * そのフィードの記事を取り直して手元を上書きする。
   *
   * 全文取得を切ったときに使う。サーバ側では本文が要約に戻っているが、手元には
   * 差し替わったものが残っていて、差分取得（sinceId）では取り直せない。
   * 抽出が本文でないものを掴んでいたときの戻し道なので、ここだけは全件引き直す。
   */
  async function reloadFeedEntries(id: number): Promise<void> {
    // fillRemaining と同じ形で最後まで辿る。1 ページで切ると、記事数が
    // PAGE_SIZE を超えるフィードで古い本文が手元に残り続ける
    let sinceId = 0;
    for (;;) {
      // unreadOnly の既定は true。既読の記事にも差し替わった本文が残っているので、
      // ここでは明示的に全件を引く
      const page = await getEntries({ feedId: id, sinceId, limit: PAGE_SIZE, unreadOnly: false });
      entriesStore.ingest(page.entries);
      feedsStore.absorbNewEntries();
      await saveEntries(page.entries);

      if (!page.hasMore || page.nextSinceId === null) return;
      sinceId = page.nextSinceId;
    }
  }

  /**
   * OPML の取り込み。初回クロールはサーバ側でしないので、記事はまだ無い。
   * 取り込んだ購読を一覧に出すため、bootstrap を取り直す。
   */
  async function restoreFromOpml(file: File): Promise<OpmlImportResponse> {
    const result = await importOpml(file);
    if (result.imported > 0) await applyBootstrap(await getBootstrap());
    return result;
  }

  /**
   * フィード側の変化（既読の前進とレート変更）。どちらも行単位なので、
   * 変わった行だけをまとめて手元に書き、送信キューに積む。
   */
  function flushFeeds(): void {
    const changed = feedsStore.feeds.filter(
      (feed) =>
        persisted.readSeq.get(feed.id) !== feed.readSeq ||
        persisted.rate.get(feed.id) !== feed.rate,
    );
    if (changed.length === 0) return;

    for (const feed of changed) {
      if (persisted.readSeq.get(feed.id) !== feed.readSeq) {
        persisted.readSeq.set(feed.id, feed.readSeq);
        outbox.queueRead(feed.id, feed.readSeq);
      }
      if (persisted.rate.get(feed.id) !== feed.rate) {
        persisted.rate.set(feed.id, feed.rate);
        outbox.queueRate(feed.id, feed.rate);
      }
    }
    void putFeeds(changed);
  }

  /**
   * ピンの手元への書き戻し。件数が少ないので丸ごと置き換える。
   *
   * 送信が通ってサーバの id が入ったときも書き戻す必要がある（リビジョンで拾う）。
   * 仮の id のまま残すと、次の起動でそのピンを外せなくなる
   */
  function flushPins(): void {
    // 読み進めているだけのときも、この吐き出しは 500ms ごとに走る。
    // ピンが動いていないなら、全件の書き直しを丸ごと省く（feeds / 未読例外と同じ考え方）
    if (pinsStore.revision === persisted.pinRevision) return;
    persisted.pinRevision = pinsStore.revision;
    void savePins(pinsStore.pins);
  }

  /** 未読に戻した記事の増減。例外は基本ゼロ件なので、両方空なら走査ごと省く */
  function flushUnread(): void {
    const saved = persisted.forcedUnread;
    if (saved.size === 0 && entriesStore.forcedUnread.size === 0) return;

    for (const entryId of entriesStore.forcedUnread) {
      if (saved.has(entryId)) continue;
      saved.add(entryId);
      void putEntryState(entryId);
      outbox.queueUnread(entryId, true);
    }
    // 削除しながら回るので複製を辿る
    for (const entryId of [...saved]) {
      if (entriesStore.forcedUnread.has(entryId)) continue;
      saved.delete(entryId);
      void deleteEntryState(entryId);
      outbox.queueUnread(entryId, false);
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** 手元の変化を IndexedDB に書き戻し、送信キューに積む */
  function flushLocalState(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    flushFeeds();
    flushUnread();
    flushPins();
  }

  /**
   * いまの値を差分の起点にし直す。**サーバのデータを当てた直後にだけ呼ぶ。**
   *
   * 当てた値をそのまま起点にしておかないと、サーバから来ただけの値が
   * 「手元の変更」として次の flush で送り返される。手元の未送信分は当てる前に
   * flushLocalState でキューへ出し切っているので、ここで起点を進めても失われない。
   */
  function rebasePersisted(): void {
    for (const feed of feedsStore.feeds) {
      persisted.readSeq.set(feed.id, feed.readSeq);
      persisted.rate.set(feed.id, feed.rate);
    }
    // ピンはこの直後に applyBootstrap がまとめて書き戻す
    persisted.pinRevision = pinsStore.revision;
  }

  /**
   * ローカルの既読を手元（IndexedDB）に書き戻し、サーバへの送信キューに積む。
   *
   * 書き戻しをしないと再読み込みで読んだ記事がまた出てくる。積まないと他の端末に
   * 伝わらない。どちらも「何が変わったか」を同じ差分から出すので 1 箇所にまとめる。
   */
  function persistLocalState(): void {
    // 既読が進んだこと・未読に戻したことだけを見る。全フィードを走査して差分を探すと、
    // 記事を送るたびに購読数ぶんの走査が走る
    watch(
      () => [
        feedsStore.readRevision,
        feedsStore.settingsRevision,
        entriesStore.unreadRevision,
        pinsStore.revision,
      ],
      () => {
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = setTimeout(flushLocalState, PERSIST_DELAY);
      },
    );

    // 起動シーケンスの中で進んだ分（最初の記事の表示）を先に片付ける。
    // watch は「以降の変化」しか見ないので、これが無いと手元を読み直しただけの起動で
    // 表示した記事が書き戻しも送信もされない
    flushLocalState();

    // 最終記事を読んだ直後にタブを閉じても取りこぼさない。
    // pagehide だけだと破棄が間に合わないことがあるので、先に来る visibilitychange でも流す。
    // outbox も同じ契機で送信する。ここで積んだ分をそちらが拾えるよう、先に登録しておく
    window.addEventListener('pagehide', flushLocalState);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushLocalState();
    });
  }

  return {
    phase,
    error,
    localError,
    entryCursor,
    syncedAt,
    boot,
    subscribe,
    unsubscribe,
    unsubscribeMany,
    editFeed,
    refresh,
    reloadFeedEntries,
    restoreFromOpml,
  };
});
