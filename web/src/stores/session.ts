import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  createFeed,
  deleteFeed,
  getBootstrap,
  getEntries,
  getSync,
  importOpml,
  onSessionExpired,
  refetchFeed,
  updateFeed,
} from '@/lib/api';
import type {
  BootstrapResponse,
  CreateFeedRequest,
  Entry,
  Feed,
  Pin,
  OpmlImportResponse,
  SyncResponse,
  UpdateFeedRequest,
} from '@shared/types';
import {
  deleteEntries,
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
import { isPrunable, prunedAt } from '@/lib/retention';
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
  /**
   * Access のセッションが切れた（lib/api.ts の SESSION_EXPIRED）。
   *
   * 立つと定期同期を止める。ログインし直すまで何を叩いても同じリダイレクトに
   * 当たるので、叩き続けても未読は増えない
   */
  const signedOut = ref(false);
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
    onSessionExpired(handleSignedOut);

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
      // 繋がった。次にセッションが切れたときのために 1 回分を戻す
      clearReloadChance();
      // 手元の間引きは全部揃ってから。読み始めは妨げない（完了を待たない）
      void pruneStoredEntries();
    } catch (err) {
      // 手元のデータで操作は続けられる。失敗はヘッダに出すだけに留める
      error.value = err instanceof Error ? err.message : String(err);
    }

    // **起動の取得が失敗しても張る。** オフラインで開いた場合こそ、繋がった後に
    // 自力で追いつけないと再読み込みするまで何も届かない
    startSync();
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

  /**
   * サーバの状態を手元に当てる。**bootstrap と差分同期で共通の手順。**
   *
   * 順序に意味がある（出し切ってから当てる、当てた直後に起点を取り直す）ので、
   * 2 本に分けない。片方だけ直すと不変条件 1・3 が静かに崩れる。
   *
   * @param entries この応答で届いた記事（bootstrap は全件、同期は新着だけ）
   * @param background 読んでいる最中に走る差し替えか（定期同期）
   */
  async function applyServerState(
    body: { serverTime: number; feeds: Feed[]; pins: Pin[]; maxEntryId: number },
    entries: Entry[],
    { background }: { background: boolean },
  ): Promise<void> {
    // サーバの値を当てる前に、手元の未送信分をキューへ出し切る。
    // 出し切ってあれば、当てた後の値をそのまま次の差分の起点にできる
    flushLocalState();

    entriesStore.ingest(entries);
    // まだ送信が通っていないピンは残す（setPins の中で url を突き合わせる）
    pinsStore.setPins(body.pins);
    feedsStore.setFeeds(body.feeds, { keepOrder: background });
    // レートはサーバの値をそのまま受けるので、まだ届いていない変更を当て直す
    feedsStore.applyPendingRates(outbox.pendingRates());
    rebasePersisted();

    if (!feedsStore.started) feedsStore.enterFirstUnread();
    else feedsStore.absorbNewEntries();

    // **サーバの未読数をそのまま信じない。** u で未読に戻した記事はサーバが知らず、
    // 保持期間で手元から消した記事はサーバにまだある。どちらも手元で数え直す。
    //
    // 起動時は記事の取り直し（fillRemaining）が終わってから boot が呼ぶので、ここでは触らない。
    // 全記事の走査で 5 分に 1 度 1.5ms 前後。記事送りの経路には乗らない
    if (background) feedsStore.recountUnread();

    entryCursor.value = body.maxEntryId;
    syncedAt.value = body.serverTime;
    error.value = null;

    await Promise.all([
      saveFeeds(feedsStore.feeds),
      saveEntries(entries),
      savePins(pinsStore.pins),
      saveCursor(body.maxEntryId, body.serverTime),
    ]);
  }

  function applyBootstrap(body: BootstrapResponse): Promise<void> {
    return applyServerState(body, body.entries, { background: false });
  }

  /**
   * 差分同期の間隔（docs/API.md「起動後の定期ポーリング（既定 5 分間隔）」）。
   * サーバの取得も 5 分ごとなので、これより短くしても空振りが増えるだけ
   */
  const SYNC_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * タブに戻ったときの同期を、これより短い間隔では繰り返さない。
   * 行き来のたびに叩くと、隣のタブを覗いただけで往復が積み上がる
   */
  const SYNC_MIN_GAP_MS = 30 * 1000;

  /** 同期が走っている間は次を始めない。遅い回線で要求が積み上がらないように */
  let syncing = false;
  let lastSyncAt = 0;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * セッションが切れたときの後始末。
   *
   * **見えていない間だけ再読み込みする。** 復帰にはログインし直すしかなく、
   * それはナビゲーション要求（＝再読み込み）でしか通らない。ただし読んでいる最中に
   * 勝手に飛ばすと、読みかけの記事ごとログイン画面に持っていかれる。隠れている間なら
   * 邪魔にならないので、そこで済ませて戻ってきたときには繋がっている状態にする。
   * 見えている間は帯を出して、押すかどうかを本人に委ねる（docs/UX.md）。
   *
   * 手元に積んだ既読は IndexedDB に残るので、再読み込みしても失われない（不変条件 3）。
   */
  function handleSignedOut(): void {
    if (signedOut.value) return;
    signedOut.value = true;
    if (syncTimer !== null) clearInterval(syncTimer);
    reloadWhenHidden();
  }

  function reloadWhenHidden(): void {
    if (document.visibilityState === 'visible') {
      // まだ見えている。次に隠れたときに済ませる
      document.addEventListener('visibilitychange', reloadWhenHidden, { once: true });
      return;
    }
    // **このタブでは 1 回だけ。** 読み込み直してもログイン画面へ行き着かない状況
    // （画面は配られるのに API だけ弾かれる等）だと、裏で延々と読み込み直すことになる。
    // 2 回目からは帯だけ出して本人に委ねる
    if (takeReloadChance()) void reloadNow();
  }

  /**
   * **手元への書き込みが終わってから飛ぶ。** 同じ visibilitychange で
   * flushLocalState が投げた IndexedDB のトランザクションは、待たずに
   * ナビゲーションすると中断される。直前に読んだ分の既読が手元からも消えて、
   * 読み込み直した先でまた未読として出てくる。
   */
  async function reloadNow(): Promise<void> {
    await localWrites.catch(() => undefined);
    window.location.reload();
  }

  /**
   * 自動での読み込み直しをこのタブで使い切ったか。
   *
   * sessionStorage はタブを閉じるまで残り、読み込み直しをまたいで引き継がれる。
   * **使えない設定のブラウザでは自動で読み込み直さない。** 数えられないまま
   * リロードすると、失敗し続ける状況で歯止めがゼロになる（隠れたタブが延々と
   * 読み込み直す）。帯は出ているので、押せば同じところに行き着く。
   */
  const RELOAD_KEY = 'ratatoskr:relogin';

  function takeReloadChance(): boolean {
    try {
      if (sessionStorage.getItem(RELOAD_KEY) !== null) return false;
      sessionStorage.setItem(RELOAD_KEY, '1');
      return true;
    } catch {
      return false;
    }
  }

  function clearReloadChance(): void {
    try {
      sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      // 消せなくても実害は無い（次の 1 回を諦めるだけ）
    }
  }

  /**
   * サーバとの差分同期。**バックグラウンドでも回す**ので、失敗しても画面には出さない。
   *
   * 読んでいる最中に走るので、カーソルは動かさない。新着はいま見ているフィードの
   * 末尾に足されるだけで（absorbNewEntries）、読んでいる位置は変わらない。
   */
  async function sync(): Promise<void> {
    // **signedOut は timer と別に見る。** 起動の取得で踏んだ場合、止める対象の
    // タイマはまだ張られていない（startSync は boot の末尾）
    if (syncing || signedOut.value || phase.value === 'booting') return;
    syncing = true;
    try {
      const body = await getSync({ entryCursor: entryCursor.value, since: syncedAt.value });
      await applySync(body);
    } catch (err) {
      // 次の回で取り直せる。読んでいる最中に知らせても手立てが無い
      // （セッション切れだけは例外で、onSessionExpired が別に受けている）
      console.warn('差分同期に失敗', err);
    } finally {
      syncing = false;
      // **失敗しても記録する。** 成功時だけにすると、繋がらない間はタブを行き来する
      // たびに毎回叩きに行くことになる（下の間引きが効かない）
      lastSyncAt = Date.now();
    }
  }

  function applySync(body: SyncResponse): Promise<void> {
    return applyServerState(body, body.newEntries, { background: true });
  }

  /**
   * 定期同期を張る（docs/API.md）。
   *
   * **タブが隠れていても止めない。** 新着に気付けるようにするのが目的なので
   * （issue #7）、ブラウザがバックグラウンドのタイマを間引くのは構わない。
   * 戻ってきたときにも 1 回叩いて、隠れている間に間引かれた分を取り戻す。
   */
  function startSync(): void {
    syncTimer = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (signedOut.value) return;
      if (Date.now() - lastSyncAt < SYNC_MIN_GAP_MS) return;
      void sync();
    });
  }

  /**
   * 保持期間を過ぎた記事を手元から捨てる（M9。規則は lib/retention.ts）。
   *
   * **サーバ側の削除は差分に載らない。** `GET /api/entries` は sinceId で前へ進むだけで、
   * 消えた記事を教える手立てが無い。こちらで同じ規則で捨てないと、同期した記事が
   * 端末に永久に積み上がる（スマホの長期運用で効いてくる）。
   *
   * 貯蔵庫（メモリ）からは落とさない。この起動の間は k で戻れば読めたままにしておき、
   * 次の起動で消える形にする。サーバから取り直せない記事ではないので、揃えても得が無い。
   */
  async function pruneStoredEntries(): Promise<void> {
    const before = prunedAt(Math.floor(Date.now() / 1000));
    const pinnedUrls = pinsStore.urls;
    const forcedUnread = entriesStore.forcedUnread;

    const ids: number[] = [];
    for (const feed of feedsStore.feeds) {
      for (const entry of entriesStore.of(feed.id)) {
        const context = { before, readSeq: feed.readSeq, pinnedUrls, forcedUnread };
        if (isPrunable(entry, context)) ids.push(entry.id);
      }
    }
    if (ids.length === 0) return;

    try {
      await deleteEntries(ids);
    } catch (err) {
      // 消せなくても読む分には困らない。次の起動でまた試す
      console.error('手元の記事の間引きに失敗', err);
    }
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
  async function subscribe(params: CreateFeedRequest): Promise<
    | { kind: 'created' }
    | {
        kind: 'candidates';
        candidates: { url: string; title: string | null }[];
        foundAt: string;
      }
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
    trackLocalWrite(putFeeds(changed));
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
    trackLocalWrite(savePins(pinsStore.pins));
  }

  /** 未読に戻した記事の増減。例外は基本ゼロ件なので、両方空なら走査ごと省く */
  function flushUnread(): void {
    const saved = persisted.forcedUnread;
    if (saved.size === 0 && entriesStore.forcedUnread.size === 0) return;

    for (const entryId of entriesStore.forcedUnread) {
      if (saved.has(entryId)) continue;
      saved.add(entryId);
      trackLocalWrite(putEntryState(entryId));
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

  /**
   * 手元への書き込みの現在地。**完了を待ちたいのは離脱の直前だけ**なので、
   * 呼び出し側には await させず、最後の 1 本をここで持っておく
   */
  let localWrites: Promise<unknown> = Promise.resolve();

  function trackLocalWrite(write: Promise<unknown>): void {
    localWrites = write;
  }

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
    signedOut,
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
