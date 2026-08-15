import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Entry, Feed } from '@shared/types';
import { useEntriesStore } from './entries';

/**
 * 読む順序（レート降順 → 未読数降順）。サーバの ORDER BY と同じ規則。
 *
 * IndexedDB から読み戻した配列は id 順になっていて順序が失われているので、
 * 手元から復元するときはこれで並べ直す。並べ替えるのは起動時だけで、
 * 読んでいる最中は動かさない（現在位置を見失うため）。
 */
export function sortByReadingOrder(feeds: Feed[]): Feed[] {
  return [...feeds].sort((a, b) => b.rate - a.rate || b.unreadCount - a.unreadCount || a.id - b.id);
}

/**
 * カーソルの単独所有者（CLAUDE.md の不変条件 2）。
 *
 * 「いまどのフィードのどの記事を読んでいるか」を持つのはここだけ。リーダー側は
 * 表示するだけで、移動要求をイベントで上に投げる。先読みのスケジューリング（M7）も
 * ここが行う。読む順序と先読み順序を一致させるため。
 */
export const useFeedsStore = defineStore('feeds', () => {
  const entriesStore = useEntriesStore();

  /**
   * サーバが返した順（レート降順 → 未読数降順）。これが読む順序であり先読み順序。
   * 読み進めて未読数が変わっても並べ替えない。読んでいる最中に左ペインが動くと
   * 現在位置を見失うため、並びの更新は次回の起動時に任せる
   */
  const feeds = ref<Feed[]>([]);
  const feedIndex = ref(-1);
  const entryIndex = ref(0);

  /**
   * いま読んでいるフィードの記事。フィードに入った時点の未読が起点で、背景取得で
   * 後から届いた分は absorbNewEntries で足す。
   * 未読を都度計算し直すと、最終記事を表示した瞬間の既読化でリストが消える
   */
  const currentEntries = ref<Entry[]>([]);

  /** このフィードに入った時点の既読位置。ここより下の記事は二度と出さない */
  const entryFloor = ref(0);

  /** 未読のあるフィードを全て消化した状態 */
  const finished = ref(false);

  /**
   * 既読が進むたびに増える。手元への書き戻し（session）がこれを見て走る。
   * 全フィードを走査して差分を探すより、進んだこと自体を伝える方が安い
   */
  const readRevision = ref(0);

  const currentFeed = computed<Feed | null>(() => feeds.value[feedIndex.value] ?? null);
  const currentEntry = computed<Entry | null>(() => currentEntries.value[entryIndex.value] ?? null);
  const entryCount = computed(() => currentEntries.value.length);
  const started = computed(() => feedIndex.value >= 0);

  function isReadable(feed: Feed): boolean {
    return feed.unreadCount > 0;
  }

  /** 手元に記事を持っているか。既読でも読み返せるので前方向の判定とは別に要る */
  function hasEntries(feed: Feed): boolean {
    return entriesStore.of(feed.id).length > 0;
  }

  /**
   * フィード一覧を差し替える。読んでいる最中なら現在位置を id で引き継ぐ
   * （bootstrap と背景取得で何度も呼ばれる）。
   *
   * read_seq は単調増加でなければならない（不変条件 1）。M3 の時点では既読を
   * サーバに送っていないので、サーバの read_seq は常に手元より古い。
   * そのまま受けると読んだ記事が毎回の起動で未読に戻るため、必ず MAX を取る。
   */
  function setFeeds(next: Feed[]): void {
    const localReadSeq = new Map(feeds.value.map((feed) => [feed.id, feed.readSeq]));
    const currentId = currentFeed.value?.id ?? null;

    feeds.value = next.map((feed) => {
      const local = localReadSeq.get(feed.id) ?? 0;
      if (local <= feed.readSeq) return feed;
      // 手元の方が進んでいる。未読数もその位置で数え直す
      return {
        ...feed,
        readSeq: local,
        unreadCount: entriesStore.countUnread(feed.id, local),
      };
    });

    if (currentId === null) return;
    const moved = feeds.value.findIndex((feed) => feed.id === currentId);
    // 購読が消えていたら次の未読フィードに逃がす
    if (moved === -1) enterFirstUnread();
    else feedIndex.value = moved;
  }

  /**
   * 未読数を手元の記事から数え直す。
   * 背景取得が終わって「未読記事を全て持っている」状態になってから呼ぶこと。
   * 途中で呼ぶと、まだ届いていない記事の分だけ未読数が少なく出る。
   */
  function recountUnread(): void {
    for (const feed of feeds.value) {
      feed.unreadCount = entriesStore.countUnread(feed.id, feed.readSeq);
    }
  }

  /** 起動時に 1 回。未読の先頭フィードにカーソルを置く */
  function enterFirstUnread(): void {
    const index = feeds.value.findIndex(isReadable);
    if (index === -1) {
      feedIndex.value = -1;
      currentEntries.value = [];
      finished.value = feeds.value.length > 0;
      return;
    }
    enterFeed(index, 'first');
  }

  function enterFeed(index: number, position: 'first' | 'last'): void {
    const feed = feeds.value[index];
    if (feed === undefined) return;

    const unread = entriesStore.unreadOf(feed.id, feed.readSeq);
    // 既読のフィードに戻ってきたときは読み返せるように全件を出す
    const list = unread.length > 0 ? unread : entriesStore.of(feed.id);
    const landing = position === 'first' ? 0 : Math.max(0, list.length - 1);

    // 記事リストと位置を別々に書き換えると、その途中の一瞬だけ
    // 「新しいフィードの、前のフィードでの位置の記事」を指した状態が生まれる。
    // 既読化はカーソルの変化に紐付いているので、それだけで未表示の記事が既読になる。
    // 一度空にしてから入れ替えて、中途半端な組み合わせを作らない
    currentEntries.value = [];
    feedIndex.value = index;
    entryIndex.value = landing;
    entryFloor.value = unread.length > 0 ? feed.readSeq : 0;
    finished.value = false;
    currentEntries.value = list;
  }

  /**
   * 背景取得で後から届いた記事を、いま読んでいるフィードのリストに足す。
   *
   * bootstrap が同梱するのは 1 フィードあたり 50 件までなので、これをしないと
   * 51 件目以降が「表示されないまま既読になる」。新着が既読にならないことは
   * 不変条件 1 の要（docs/DESIGN.md §4）。
   */
  function absorbNewEntries(): void {
    const feed = currentFeed.value;
    if (feed === null) return;

    const known = new Set(currentEntries.value.map((entry) => entry.id));
    const additions = entriesStore
      .of(feed.id)
      .filter((entry) => entry.id > entryFloor.value && !known.has(entry.id));
    if (additions.length === 0) return;

    const currentId = currentEntry.value?.id ?? null;
    currentEntries.value = [...currentEntries.value, ...additions].sort((a, b) => a.id - b.id);

    // 読んでいる記事を見失わないよう、id で位置を取り直す
    if (currentId !== null) {
      const moved = currentEntries.value.findIndex((entry) => entry.id === currentId);
      if (moved !== -1) entryIndex.value = moved;
    }
    // 届いた分を未読数にも反映する。左ペインの数字は手元の記事から数える
    feed.unreadCount = entriesStore.countUnread(feed.id, feed.readSeq);
  }

  function findFeed(from: number, step: 1 | -1, accept: (feed: Feed) => boolean): number {
    for (let i = from; i >= 0 && i < feeds.value.length; i += step) {
      if (accept(feeds.value[i])) return i;
    }
    return -1;
  }

  /** 前に進むときは未読のあるフィードだけを辿る。未読 0 のフィードは一覧には出るが飛ばす */
  function nextFeed(): void {
    const index = findFeed(feedIndex.value + 1, 1, isReadable);
    if (index === -1) {
      // 最後まで読み切った。先頭には戻さない（既読の記事を回り続けないため）
      finished.value = true;
      return;
    }
    enterFeed(index, 'first');
  }

  /**
   * 戻るときは未読の有無で絞らない。読み終えたフィードは未読 0 になるので、
   * 絞ると「いま読み終えたばかりのフィードに戻れない」ことになる。
   */
  function prevFeed(position: 'first' | 'last' = 'first'): void {
    const index = findFeed(feedIndex.value - 1, -1, hasEntries);
    if (index === -1) return;

    // 未読が残っているフィード（s で飛ばしたもの）に末尾から入ると、
    // 間の記事をまとめて既読にしてしまう。その場合だけ先頭に着地する
    const landing = position === 'last' && isReadable(feeds.value[index]) ? 'first' : position;
    enterFeed(index, landing);
  }

  function nextEntry(): void {
    if (!started.value) return;
    if (entryIndex.value < currentEntries.value.length - 1) {
      entryIndex.value += 1;
      return;
    }
    nextFeed();
  }

  function prevEntry(): void {
    if (!started.value) return;
    if (entryIndex.value > 0) {
      entryIndex.value -= 1;
      // 「全て読み終えた」から記事に戻ってきた場合は表示を戻す
      finished.value = false;
      return;
    }
    // 逆方向に読み進める形なので、前のフィードの最終記事に着地する
    prevFeed('last');
  }

  function selectFeed(id: number): void {
    const index = feeds.value.findIndex((feed) => feed.id === id);
    if (index !== -1) enterFeed(index, 'first');
  }

  /** 左ペインの記事一覧から直接飛ぶ。飛び越した記事も既読になる（順に読む前提） */
  function selectEntry(id: number): void {
    const index = currentEntries.value.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    entryIndex.value = index;
  }

  /**
   * このフィードを全部既読にして次へ。未読が溜まって「もう今日は読まない」ときに使う。
   * LDR の touch_all にあたる操作。
   */
  function readAllAndNext(): void {
    const feed = currentFeed.value;
    if (feed !== null) {
      // 手元にある分までを既読にする。取得後にサーバへ届いた記事は巻き込まない
      advanceReadSeq(feed, entriesStore.maxIdOf(feed.id));
    }
    nextFeed();
  }

  /**
   * 既読化。**記事を表示した時点**でその記事まで進める。離脱時ではない
   * （離脱を待つと外部リンクを開いて戻らなかった場合に取りこぼす。docs/UX.md）。
   *
   * 表示した記事の id までしか進めない。手元にある全記事の最大 id を使うと、
   * 背景取得で届いただけでまだ表示していない記事まで既読にしてしまう。
   *
   * M3 の時点ではローカルにしか反映しない。サーバへの送信は M4 の outbox で足す。
   */
  function advanceReadSeq(feed: Feed, watermark: number): void {
    // 巻き戻さないよう必ず MAX を取る（不変条件 1）
    if (watermark <= feed.readSeq) return;
    feed.readSeq = watermark;
    feed.unreadCount = entriesStore.countUnread(feed.id, watermark);
    readRevision.value += 1;
  }

  /**
   * 表示した記事は必ず既読にする。移動の経路（j / k / s / a / 一覧クリック）ごとに
   * 呼び忘れないよう、カーソルの変化そのものに紐付けている。
   * sync で流すのは、テストと E2E で「押した直後の状態」を素直に見られるようにするため。
   */
  watch(
    currentEntry,
    (entry) => {
      const feed = currentFeed.value;
      if (feed !== null && entry !== null) advanceReadSeq(feed, entry.id);
    },
    { flush: 'sync' },
  );

  return {
    feeds,
    feedIndex,
    entryIndex,
    currentEntries,
    finished,
    readRevision,
    currentFeed,
    currentEntry,
    entryCount,
    started,
    setFeeds,
    recountUnread,
    enterFirstUnread,
    absorbNewEntries,
    selectFeed,
    selectEntry,
    readAllAndNext,
    nextEntry,
    prevEntry,
    nextFeed,
    prevFeed,
  };
});
