import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Entry, Feed } from '@shared/types';
import { imageUrlsOf, prefetchImages } from '@/lib/prefetch';
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

/** 画像を先読みするフィード数（現在のフィードの先。docs/DESIGN.md §6） */
const PREFETCH_FEEDS = 3;

/**
 * 一度に温める画像の枚数。フィード数だけで区切ると、画像の多いフィードが 4 本
 * 並んだだけで数百枚を取りに行くことになる。画像を落とし切れないからウィンドウに
 * したのに、それでは元の木阿弥（docs/DESIGN.md §6）。LDRoid の PREFETCH_COUNT が
 * 件数の上限だったのと同じ考え方。
 */
const PREFETCH_IMAGES = 40;

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

  /** レートなど、ユーザが決める設定が変わるたびに増える。用途は readRevision と同じ */
  const settingsRevision = ref(0);

  const currentFeed = computed<Feed | null>(() => feeds.value[feedIndex.value] ?? null);
  const currentEntry = computed<Entry | null>(() => currentEntries.value[entryIndex.value] ?? null);
  const entryCount = computed(() => currentEntries.value.length);
  const started = computed(() => feedIndex.value >= 0);

  function isReadable(feed: Feed): boolean {
    return feed.unreadCount > 0;
  }

  /**
   * 読む対象を絞っているフォルダ（issue #3。方針は docs/UX.md の「フォルダ」）。
   * null は絞り込み無し。**覚えておかない**（再読み込みで解除する）
   */
  const folder = ref<string | null>(null);

  function inFolder(feed: Feed): boolean {
    return folder.value === null || feed.folder === folder.value;
  }

  /**
   * 左ペインに並べるフィード。絞り込みの外は出さない。
   *
   * 絞っていないときに `feeds.value` をそのまま返すのは、**同じ配列を返して
   * 左ペインの再描画を誘発しないため**（filter は毎回新しい配列になる）。
   * 絞っていない状態が常態なので、そこだけ写しを作らない
   */
  const visibleFeeds = computed(() =>
    folder.value === null ? feeds.value : feeds.value.filter(inFolder),
  );

  /**
   * 使われているフォルダ名。絞り込みの選択肢と、購読管理の入力候補で同じものを引く。
   * 未分類（空文字）は最後に置く。名前として並べる先が無いため
   */
  const folders = computed(() => {
    const names = [...new Set(feeds.value.map((feed) => feed.folder))];
    return names.sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'ja')));
  });

  /**
   * 絞り込みを切り替える。**外に出たカーソルは連れ戻す。**
   * 置き去りにすると、s / a も先読みも「見えていないフィード」を起点に回る
   */
  function setFolder(next: string | null): void {
    if (folder.value === next) return;
    folder.value = next;

    // 新しい範囲でカーソルがまだ有効かを見る。**読み終えた状態も無効に含める。**
    // 絞った範囲を読み切ってから広げると、新しい範囲に未読があっても
    // 「全て読み終えた」が出たままになる
    if (finished.value || currentFeed.value === null || !inFolder(currentFeed.value)) {
      enterFirstUnread();
    }
  }

  /**
   * 絞り込みの外に残っている未読の数。絞っていなければ 0。
   *
   * **読み終えた画面で範囲を明かすために要る。** 絞ったまま「全て読み終えた」とだけ
   * 出すと、未読があるのに無いように見える（docs/UX.md の「フォルダ」）。狭い画面では
   * 絞り込みの表示そのものが引き出しの中なので、開くまで理由に辿り着けない
   */
  const unreadOutsideScope = computed(() =>
    folder.value === null
      ? 0
      : feeds.value.reduce((sum, feed) => (inFolder(feed) ? sum : sum + feed.unreadCount), 0),
  );

  /**
   * 絞っていたフォルダが消えたら（購読解除・改名）絞り込みも外す。
   *
   * **外さないと詰む。** 一覧は空になり、選択肢が 1 つになった時点で絞り込みを
   * 解除する導線ごと消えるので、再読み込みするまで残りの未読に辿り着けない
   */
  watch(folders, (names) => {
    if (folder.value !== null && !names.includes(folder.value)) setFolder(null);
  });

  /** 手元に記事を持っているか。既読でも読み返せるので前方向の判定とは別に要る */
  function hasEntries(feed: Feed): boolean {
    return entriesStore.of(feed.id).length > 0;
  }

  /** 左ペインの未読数は手元の記事から数える。数え方を 1 箇所に閉じておく */
  function syncUnreadCount(feed: Feed): void {
    feed.unreadCount = entriesStore.countUnread(feed.id, feed.readSeq);
  }

  /**
   * 読む順序に並べ直す。現在位置は id で引き継ぐ（並びが変わっても同じフィードに乗せる）。
   * 並べ直すのはユーザが明示的に順序を変えたときだけで、読み進めただけでは動かさない。
   */
  function resortKeepingCursor(): void {
    const currentId = currentFeed.value?.id ?? null;
    feeds.value = sortByReadingOrder(feeds.value);
    if (currentId === null) return;
    feedIndex.value = feeds.value.findIndex((feed) => feed.id === currentId);
  }

  /**
   * フィード一覧を差し替える。読んでいる最中なら現在位置を id で引き継ぐ
   * （bootstrap と背景取得で何度も呼ばれる）。
   *
   * read_seq は単調増加でなければならない（不変条件 1）。既読の送信は outbox 経由で
   * 遅れて届くので、サーバの read_seq は手元より古いことがある。そのまま受けると
   * 読んだ記事が未読に戻るため、必ず MAX を取る（docs/API.md の sync 節）。
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
   * 購読の追加と設定変更を一覧に反映する（購読管理画面から呼ぶ）。
   *
   * 並びは読む順序に保つ。追加も設定変更もユーザの明示的な操作なので、
   * ここで並べ替わるのは意図どおり（読み進めただけでは並べ替えない）。
   */
  function upsertFeed(next: Feed): void {
    const index = feeds.value.findIndex((feed) => feed.id === next.id);

    if (index === -1) {
      feeds.value = [...feeds.value, next];
    } else {
      // 既読は手元の方が進んでいることがある。サーバの値で巻き戻さない（不変条件 1）
      const local = feeds.value[index];
      feeds.value[index] = { ...next, readSeq: Math.max(local.readSeq, next.readSeq) };
      syncUnreadCount(feeds.value[index]);
    }
    resortKeepingCursor();
  }

  /**
   * まだサーバに届いていないレート変更を、サーバの一覧に当て直す。
   *
   * setFeeds はサーバの値をそのまま受けるので、送信待ちのレートがあると
   * 一度サーバの古い値に戻ってしまう（左ペインの並びも戻る）。
   * 手元の変更が勝つのは既読と同じ考え方（不変条件 1・3）。
   */
  function applyPendingRates(rates: Map<number, number>): void {
    if (rates.size === 0) return;

    let changed = false;
    for (const feed of feeds.value) {
      const rate = rates.get(feed.id);
      if (rate === undefined || feed.rate === rate) continue;
      feed.rate = rate;
      changed = true;
    }
    if (changed) resortKeepingCursor();
  }

  /**
   * 購読を解除する。読んでいたフィードが消えたら次の未読へ逃がす。
   * 消えた記事のうち未読例外だったものを返す（手元の記録の後始末に使う）。
   */
  function dropFeed(id: number): number[] {
    const currentId = currentFeed.value?.id ?? null;
    feeds.value = feeds.value.filter((feed) => feed.id !== id);
    const droppedUnread = entriesStore.dropFeed(id);

    if (currentId === id) enterFirstUnread();
    else if (currentId !== null) {
      feedIndex.value = feeds.value.findIndex((feed) => feed.id === currentId);
    }
    return droppedUnread;
  }

  /**
   * 未読数を手元の記事から数え直す。
   * 背景取得が終わって「未読記事を全て持っている」状態になってから呼ぶこと。
   * 途中で呼ぶと、まだ届いていない記事の分だけ未読数が少なく出る。
   */
  function recountUnread(): void {
    for (const feed of feeds.value) syncUnreadCount(feed);
  }

  /**
   * レートを変える（1–5 キー）。左ペインの並びは**その場で**組み替える。
   * レートは「読む順の管理」そのものなので、変えた結果が次の s / a に効かないと
   * 意味がない（docs/UX.md「レート」）。
   *
   * 読み進めている間に並びを変えないのは未読数が減ったときの話で、
   * ユーザが明示的に順序を変えたこのときは別。現在位置は id で引き継ぐ。
   */
  function setRate(rate: number): void {
    const feed = currentFeed.value;
    if (feed === null || feed.rate === rate) return;

    feed.rate = rate;
    resortKeepingCursor();
    settingsRevision.value += 1;
  }

  /**
   * 手動更新（r キー）で増えた記事を、いま読んでいるフィードに反映する。
   * 取得そのものはサーバ仕事なので、呼び出し側が結果を持ってくる。
   */
  function applyFetched(feed: Feed): void {
    const index = feeds.value.findIndex((candidate) => candidate.id === feed.id);
    if (index === -1) return;
    // 既読は手元の方が進んでいることがある。サーバの値で巻き戻さない（不変条件 1）
    const local = feeds.value[index];
    local.readSeq = Math.max(local.readSeq, feed.readSeq);
    local.lastFetchedAt = feed.lastFetchedAt;
    // 失敗の状態は 3 つで 1 組。片方だけ持ち越すと、文言は消えたのに分類だけ残って
    // 「取得できないフィード」として一括解除に巻き込まれる
    local.lastError = feed.lastError;
    local.lastErrorKind = feed.lastErrorKind;
    local.consecutiveFailures = feed.consecutiveFailures;
    // 全文取得の状態も持ち越す。クロール中に「要約しか配信していない」と判れば
    // その場で勧めたい（次の起動まで待たせない）
    local.fullText = feed.fullText;
    local.fullTextSuggested = feed.fullTextSuggested;
    syncUnreadCount(local);
    if (index === feedIndex.value) absorbNewEntries();
  }

  /**
   * いまの範囲の先頭の未読にカーソルを座らせ直す。起動時のほか、購読が消えたとき
   * （setFeeds / dropFeed）と絞り込みを変えたとき（setFolder）にも通る
   */
  function enterFirstUnread(): void {
    const index = findFeed(0, 1, isReadable);
    if (index === -1) {
      feedIndex.value = -1;
      currentEntries.value = [];
      finished.value = feeds.value.some(inFolder);
      return;
    }
    enterFeed(index, 'first');
  }

  /** 着地先。記事を名指しできるのは、左ペインの一覧から直接飛ぶ場合（不変条件 2 の経路） */
  type Landing = 'first' | 'last' | { entryId: number };

  /**
   * そのフィードで読む記事の並び。未読があれば未読だけ、無ければ手元にある全件。
   * 既読のフィードに戻ってきたときに読み返せるようにするための規則で、
   * カーソルを入れるときと左ペインに並べるときで同じでなければならない。
   */
  function readingList(feed: Feed): Entry[] {
    const unread = entriesStore.unreadOf(feed.id, feed.readSeq);
    return unread.length > 0 ? unread : entriesStore.of(feed.id);
  }

  function enterFeed(index: number, position: Landing): void {
    const feed = feeds.value[index];
    if (feed === undefined) return;

    const unread = entriesStore.unreadOf(feed.id, feed.readSeq);
    const list = readingList(feed);
    const landing = landingIndex(list, position);

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
   * 着地する位置を決める。名指しされた記事が一覧に無ければ先頭に落とす。
   *
   * 記事を名指しできることが要るのは、途中の記事を経由させないため。
   * カーソルの変化には既読化と未読例外の解除が紐付いているので、一度先頭に
   * 着地してから動かすと、名指しされていない記事まで巻き込む
   */
  function landingIndex(list: Entry[], position: Landing): number {
    if (position === 'first') return 0;
    if (position === 'last') return Math.max(0, list.length - 1);
    const index = list.findIndex((entry) => entry.id === position.entryId);
    return index === -1 ? 0 : index;
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

    const stored = new Map(entriesStore.of(feed.id).map((entry) => [entry.id, entry]));
    const known = new Set(currentEntries.value.map((entry) => entry.id));
    const additions = [...stored.values()].filter(
      (entry) => entry.id > entryFloor.value && !known.has(entry.id),
    );
    // 本文が差し替わった記事も載せ替える（全文取得。M7）。貯蔵庫は同じ id を
    // 新しいオブジェクトで置き換えるので、同一性が変わったかどうかで見分けられる。
    // これをしないと、いま開いているフィードだけ要約のまま取り残される
    const replaced = currentEntries.value.some((entry) => stored.get(entry.id) !== entry);
    if (additions.length === 0 && !replaced) return;

    const currentId = currentEntry.value?.id ?? null;
    const rebased = currentEntries.value.map((entry) => stored.get(entry.id) ?? entry);
    const merged = [...rebased, ...additions].sort((a, b) => a.id - b.id);

    // 読んでいる記事を見失わないよう、id で位置を取り直す
    const moved = currentId === null ? -1 : merged.findIndex((entry) => entry.id === currentId);

    // enterFeed と同じ理由で、一度空にしてから入れ替える。リストだけ先に差し替えると
    // 「新しいリストの、古い位置」を指した記事が一瞬できてしまい、既読化と未読例外の
    // 解除がその記事に走る（背景取得は古い記事を足すので、位置はほぼ必ずずれる）
    currentEntries.value = [];
    if (moved !== -1) entryIndex.value = moved;
    currentEntries.value = merged;
    // 届いた分を未読数にも反映する
    syncUnreadCount(feed);
  }

  function findFeed(from: number, step: 1 | -1, accept: (feed: Feed) => boolean): number {
    // **絞り込みはここだけで効かせる。** s / a も先読みもこの関数を通るので、
    // 添字を振り直さずに対象を狭められる（feedIndex は全体配列の添字のまま）。
    //
    // 一覧と絞り込みをループの外で読むのは、記事送り 1 回でここを何周もするため。
    // reactive proxy の添字アクセスと ref 読みは毎周ぶんが積み上がる
    // （素直に書いた版は 100 フィードで実測 1.5 倍かかった）
    const list = feeds.value;
    const only = folder.value;
    for (let i = from; i >= 0 && i < list.length; i += step) {
      const feed = list[i];
      if ((only === null || feed.folder === only) && accept(feed)) return i;
    }
    return -1;
  }

  /**
   * 前に進むときは未読のあるフィードだけを辿る。未読 0 のフィードは一覧には出るが飛ばす。
   *
   * 探すのは**前方向だけ**。先頭には戻さない（既読の記事を回り続けないため。
   * docs/ROADMAP.md の M3「全て読み終えたら先頭に戻らず止まる」）。
   * s で飛ばした未読は a で戻って読む。
   */
  function nextFeed(): void {
    const index = findFeed(feedIndex.value + 1, 1, isReadable);
    if (index === -1) {
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
    // カーソルがどこにも無いとき（未読を全て読み終えた・絞った先が全て既読）は
    // 末尾から探す。**そうしないと読み返す手段が無くなる**（a はそのためのキー）
    const from = feedIndex.value === -1 ? feeds.value.length - 1 : feedIndex.value - 1;
    const index = findFeed(from, -1, hasEntries);
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
   * 左ペインで開いた別のフィードの記事に飛ぶ（カーソルの持ち主はここ 1 つ。不変条件 2）。
   *
   * そのフィードの先頭を経由しない。経由すると、経由した記事の未読例外（u）が
   * 「表示した」とみなされて解ける。
   */
  function selectEntryIn(feedId: number, entryId: number): void {
    if (currentFeed.value?.id === feedId) {
      selectEntry(entryId);
      return;
    }
    const index = feeds.value.findIndex((feed) => feed.id === feedId);
    if (index !== -1) enterFeed(index, { entryId });
  }

  /**
   * 左ペインに並べる記事。読んでいる最中のフィードは、入った時点で確定した一覧を返す
   * （未読を都度計算し直すと、最終記事を表示した瞬間に一覧が消える）。
   * それ以外のフィードは readingList そのもの。
   */
  function entriesFor(feedId: number): Entry[] {
    if (currentFeed.value?.id === feedId) return currentEntries.value;

    const feed = feeds.value.find((candidate) => candidate.id === feedId);
    return feed === undefined ? [] : readingList(feed);
  }

  /**
   * このフィードを全部既読にして次へ。未読が溜まって「もう今日は読まない」ときに使う。
   * LDR の touch_all にあたる操作。
   */
  function readAllAndNext(): void {
    const feed = currentFeed.value;
    if (feed !== null) {
      // 未読に戻した記事も「全て既読」に含める。残すとこのフィードが未読のまま居座る
      const cleared = entriesStore.clearForcedUnreadIn(feed.id);
      // 手元にある分までを既読にする。取得後にサーバへ届いた記事は巻き込まない
      advanceReadSeq(feed, entriesStore.maxIdOf(feed.id));
      if (cleared) syncUnreadCount(feed);
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
   * ここではローカルにしか反映しない。手元への書き戻しとサーバへの送信は、
   * readRevision を見ている stores/session.ts が outbox 経由で行う（不変条件 3）。
   */
  function advanceReadSeq(feed: Feed, watermark: number): void {
    // 巻き戻さないよう必ず MAX を取る（不変条件 1）
    if (watermark <= feed.readSeq) return;
    feed.readSeq = watermark;
    syncUnreadCount(feed);
    readRevision.value += 1;
  }

  /**
   * 現在の記事を未読に戻す（u キー）。ウォーターマークは動かさない。
   * 動かすとこの記事より後ろの既読が全て巻き戻るので、例外として 1 件だけ記録する
   * （docs/DESIGN.md §4 の entry_states）。
   */
  function markCurrentUnread(): void {
    const feed = currentFeed.value;
    const entry = currentEntry.value;
    if (feed === null || entry === null) return;
    if (!entriesStore.setForcedUnread(entry.id, true)) return;
    syncUnreadCount(feed);
  }

  /**
   * 先読みするウィンドウ（docs/DESIGN.md §6）。**読む順そのままに並べる。**
   * 読む順序と先読み順序が一致していることが、先読みが当たる前提条件。
   *
   * 現在のフィードは「いま読んでいる記事より先」だけを積む。既に表示した記事の
   * 画像はもう取れているので、積み直しても順番待ちを増やすだけになる。
   *
   * 先のフィードの辿り方は s（nextFeed）と同じ規則にしてある。未読 0 のフィードを
   * 飛ばさないと、実際には開かないフィードの画像でウィンドウが埋まる。
   *
   * **キーを押すたびに丸ごと計算し直す。** 前回のウィンドウをずらす形にはしていない。
   * 100 フィード × 50 記事（docs/DESIGN.md の想定規模の上限）で記事送り 1 回あたり
   * 0.176ms と実測した。1 フレームの 1% で、差分更新の状態を持つ価値がない。
   */
  const prefetchUrls = computed<string[]>(() => {
    if (!started.value) return [];

    const urls: string[] = [];
    /** @returns 上限に達したか。達したらそこで打ち切る */
    const take = (entry: Entry): boolean => {
      urls.push(...imageUrlsOf(entry));
      return urls.length >= PREFETCH_IMAGES;
    };

    for (const entry of currentEntries.value.slice(entryIndex.value + 1)) {
      if (take(entry)) return urls.slice(0, PREFETCH_IMAGES);
    }

    let index = feedIndex.value;
    for (let n = 0; n < PREFETCH_FEEDS; n += 1) {
      index = findFeed(index + 1, 1, isReadable);
      if (index === -1) break;
      for (const entry of readingList(feeds.value[index])) {
        if (take(entry)) return urls.slice(0, PREFETCH_IMAGES);
      }
    }
    return urls;
  });

  // 先読みのスケジューリングもカーソルの所有者が行う（不変条件 2）
  watch(prefetchUrls, (urls) => prefetchImages(urls));

  /** 直前に表示した記事。カーソルが動いたのか、足元のリストが入れ替わっただけかを見分ける */
  let displayed: number | null = null;

  /**
   * 表示した記事は必ず既読にする。移動の経路（j / k / s / a / 一覧クリック）ごとに
   * 呼び忘れないよう、カーソルの変化そのものに紐付けている。
   * sync で流すのは、テストと E2E で「押した直後の状態」を素直に見られるようにするため。
   *
   * 未読に戻した記事をもう一度**表示しに行った**ときは例外を外す。「表示したら既読」を
   * 唯一の規則にしておかないと、一度 u を押した記事が読んでも消えなくなる。
   *
   * ただし反応するのはカーソルが別の記事に動いたときだけ。リストの差し替え
   * （enterFeed / absorbNewEntries）でも currentEntry は一度 null を挟んで作り直されるので、
   * それに反応すると、いま座っている記事に押した u が背景取得のたびに消える。
   */
  watch(
    currentEntry,
    (entry) => {
      const feed = currentFeed.value;
      if (feed === null || entry === null) return;
      if (entry.id === displayed) return;
      displayed = entry.id;

      if (entriesStore.setForcedUnread(entry.id, false)) syncUnreadCount(feed);
      advanceReadSeq(feed, entry.id);
    },
    { flush: 'sync' },
  );

  return {
    feeds,
    visibleFeeds,
    folders,
    folder,
    unreadOutsideScope,
    setFolder,
    feedIndex,
    entryIndex,
    currentEntries,
    finished,
    prefetchUrls,
    readRevision,
    settingsRevision,
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
    selectEntryIn,
    entriesFor,
    readAllAndNext,
    markCurrentUnread,
    setRate,
    applyFetched,
    upsertFeed,
    applyPendingRates,
    dropFeed,
    nextEntry,
    prevEntry,
    nextFeed,
    prevFeed,
  };
});
