<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import BottomBar from '@/components/BottomBar.vue';
import EntryReader from '@/components/EntryReader.vue';
import FeedList from '@/components/FeedList.vue';
import { confirmUnsubscribe, folderLabel, isStalled } from '@/lib/subscriptions';
import HelpOverlay from '@/components/HelpOverlay.vue';
import PinList from '@/components/PinList.vue';
import SubscriptionManager from '@/components/SubscriptionManager.vue';
import { pendingSubscription } from '@/lib/bookmarklet';
import { isTextInput, resolveBinding, type KeyBinding } from '@/lib/keymap';
import { hasSeenHelp, markHelpSeen } from '@/lib/prefs';
import { useCompact } from '@/lib/viewport';
import type { Pin } from '@shared/types';
import { useFeedsStore } from '@/stores/feeds';
import { useOutboxStore } from '@/stores/outbox';
import { usePinsStore } from '@/stores/pins';
import { useSessionStore } from '@/stores/session';

/**
 * キー入力の受け口はここ 1 箇所だけ。個別のコンポーネントに keydown を散らさない
 * （CLAUDE.md）。押されたキーは keymap.ts が Action に落とし、ここは Action に
 * 対する処理だけを書く。
 */
const feeds = useFeedsStore();
const pins = usePinsStore();
const outbox = useOutboxStore();
const session = useSessionStore();

const reader = ref<InstanceType<typeof EntryReader> | null>(null);

/**
 * 狭い画面では記事ビューが既定で、フィード一覧はヘッダから開く引き出しになる
 * （docs/UX.md「画面構成（スマホ）」）。左ペインを常に出しておける幅が無いため。
 */
const compact = useCompact();
const drawerOpen = ref(false);

// 画面が広くなったら引き出しは用済み。左ペインが常に出る側に切り替わるので、
// 開いたままにしておくと重なりだけが残る
watch(compact, (narrow) => {
  if (!narrow) drawerOpen.value = false;
});

/** 一覧から記事を選んだら引き出しは閉じる。一覧は移動手段であって選択画面ではない */
function selectEntryIn(feedId: number, entryId: number): void {
  feeds.selectEntryIn(feedId, entryId);
  drawerOpen.value = false;
}

function openManager(): void {
  drawerOpen.value = false;
  activeOverlay.value = 'subscriptions';
}

/**
 * ブックマークレットから渡された購読先（issue #4）。購読管理に渡してその場で登録させる。
 *
 * **アドレス欄からは消す。** 残したまま再読み込みされると、同じ URL をもう一度
 * 登録しに行くことになる（サーバ側は重複を弾くが、押した覚えのない知らせが出る）
 */
const pendingUrl = ref<string | null>(null);

function takePendingSubscription(): void {
  const url = pendingSubscription(window.location.search);
  if (url === null) return;

  pendingUrl.value = url;
  activeOverlay.value = 'subscriptions';
  window.history.replaceState(null, '', window.location.pathname);
}

// オーバーレイは「いま何が開いているか」で持つ。ピン一覧（M6）が増えたときに
// 表示中フラグを増やさずに済ませるため
const activeOverlay = ref<'help' | 'subscriptions' | 'pins' | null>(null);

const feedTitle = computed(() => feeds.currentFeed?.title ?? '');

/** いま読んでいる記事にピンが立っているか。本文の見出しの目印に使う */
const currentPinned = computed(() => {
  const url = feeds.currentEntry?.url;
  return url !== null && url !== undefined && pins.has(url);
});

/**
 * 取得が止まったフィードがあるか（M9）。
 *
 * 知らせの本体は左ペインの頭に出す（FeedList）。ただし狭い画面ではその左ペインが
 * 引き出しの中なので、開くまで気付けない。**入口に印だけ出す。**
 * 読む場所は邪魔せず、しかし放っておくと記事が増えないままになるのを防ぐ
 */
const stalledCount = computed(() => feeds.feeds.filter(isStalled).length);

/**
 * 境界にいるか（docs/UX.md「境界でのボタン変化」）。ボタンの位置は動かさず、
 * ラベルだけがここで変わる。j / k と同じで、押す側は境界を意識しなくてよい
 */
const atFirstEntry = computed(() => feeds.entryIndex <= 0);
const atLastEntry = computed(() => feeds.entryIndex >= feeds.entryCount - 1);

/** 手動更新やピンのように、画面が変わらないことのある操作の結果を出す場所 */
const notice = ref<string | null>(null);

function notify(message: string): void {
  notice.value = message;
}

// 知らせは短く出すだけのもの（docs/UX.md「トーストで短く通知する」）。
// 次の記事に移ったら消す。読んでいる間ずっと出ていると本文の場所を食う
watch(
  () => feeds.currentEntry?.id,
  () => {
    notice.value = null;
  },
);

/**
 * 押されたキーを処理する。処理したかどうかを返す。
 *
 * 返り値で preventDefault の要否を分けるのは、購読管理のようなフォーム UI を
 * 開いている間にブラウザ既定の操作（Space でのボタン押下、Tab 移動）を
 * 奪わないため。読んでいる間は Space を必ず横取りする（既定のスクロールと衝突する）。
 */
function handle(binding: KeyBinding): boolean {
  // オーバーレイを開いている間は、閉じる操作とその画面自身の操作だけを受け付ける
  if (activeOverlay.value !== null) {
    if (activeOverlay.value === 'pins' && binding.action === 'openAllPins') {
      openAllPins();
      return true;
    }
    if (
      binding.action !== 'closeOverlay' &&
      binding.action !== 'toggleHelp' &&
      binding.action !== 'togglePinList'
    ) {
      return false;
    }
    closeOverlay();
    return true;
  }

  switch (binding.action) {
    case 'nextEntry':
      feeds.nextEntry();
      break;
    case 'prevEntry':
      feeds.prevEntry();
      break;
    case 'nextFeed':
      feeds.nextFeed();
      break;
    case 'prevFeed':
      feeds.prevFeed();
      break;
    case 'readAllAndNext':
      feeds.readAllAndNext();
      break;
    case 'markUnread':
      feeds.markCurrentUnread();
      break;
    case 'setRate':
      // キーそのものが値を兼ねる（1–5）。並びはその場で組み替わる
      if (binding.argument !== undefined) feeds.setRate(binding.argument);
      break;
    case 'refreshFeed':
      refreshCurrentFeed();
      break;
    case 'togglePin':
      togglePin();
      break;
    case 'togglePinList':
      activeOverlay.value = 'pins';
      break;
    case 'openAllPins':
      // ピン一覧を開いていないときは何もしない（誤爆でタブが大量に開くのを避ける）
      break;
    case 'pageDown':
      // 下端に着いていたら記事送りに変わる。境界の判断は読み手が持つ（docs/UX.md）
      if (!reader.value?.pageDown()) feeds.nextEntry();
      break;
    case 'pageUp':
      if (!reader.value?.pageUp()) pageUpToPrevEntry();
      break;
    case 'openOriginal':
      openOriginal();
      break;
    case 'toggleHelp':
      activeOverlay.value = 'help';
      break;
    case 'closeOverlay':
      break;
  }
  return true;
}

/**
 * 逆送りは前の記事の**末尾**に着地する。先頭に着地すると、そのままもう一度押した時に
 * 本文を読み返せずに更に前へ飛んでしまう（docs/UX.md「Shift+Space は上方向に同じ挙動」）
 */
function pageUpToPrevEntry(): void {
  const before = feeds.currentEntry?.id ?? null;
  feeds.prevEntry();
  if (feeds.currentEntry?.id === before) return;
  void nextTick().then(() => reader.value?.scrollToBottom());
}

/**
 * 手動更新（r）。ここだけはサーバの応答を待つが、待つのは取得の結果であって
 * 記事送りではない。押した直後の操作は妨げない（await を待たずに戻る）。
 *
 * 押しても画面が変わらないことがある操作なので、結果は必ず出す。
 * 失敗を黙って捨てない（CLAUDE.md）。
 */
function refreshCurrentFeed(): void {
  const id = feeds.currentFeed?.id;
  if (id === undefined) return;

  notify('取得中…');
  session
    .refresh(id)
    .then((added) => {
      notify(added === 0 ? '新着は無かった' : `${added} 件の新着を取得した`);
    })
    .catch((err: unknown) => {
      notify(`更新に失敗した: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * 左ペインからの購読解除（issue #2）。
 *
 * 記事を読んでいる最中に「もう要らない」と判断したとき、購読管理を開かずに済ませる。
 * 解除後の後始末は既存の経路が持っている。stores/session の unsubscribe がサーバと手元を片付け、
 * stores/feeds の dropFeed が読んでいたフィードだったら次の未読へ逃がす。
 */
function unsubscribeFeed(id: number): void {
  const feed = feeds.feeds.find((candidate) => candidate.id === id);
  if (feed === undefined || !confirmUnsubscribe(feed)) return;

  session
    .unsubscribe(id)
    .then(() => {
      notify('購読を解除した');
    })
    .catch((err: unknown) => {
      notify(`解除に失敗した: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * ピンを付ける / 外す（p）。**記事は切り替えない**（docs/UX.md）。
 * 押したことが分かるよう、短い知らせだけ出す。
 */
function togglePin(): void {
  const entry = feeds.currentEntry;
  if (entry === null || entry.url === null) return;

  const existing = pins.find(entry.url);
  if (existing !== undefined) {
    removePin(existing);
    return;
  }

  const added = pins.add(entry, Math.floor(Date.now() / 1000));
  if (added === null) return;
  outbox.queuePin(added.entryId, added.title, added.url);
  notify('ピンした');
}

function removePin(pin: Pin): void {
  pins.remove(pin.url);
  outbox.queueUnpin(pin.id, pin.url);
}

/**
 * ピンを全て新しいタブで開く（o）。ピン一覧の表示中だけ効く。
 *
 * ブラウザは 1 回の操作で開ける新しいタブを 1 つに絞ることがある。
 * **開けたものだけをピンから外す。** 全部消してからブロックに気付くと、
 * 「後で処理する」控えが取り返しなく失われる。
 */
function openAllPins(): void {
  const opening = [...pins.pins];
  const blocked: Pin[] = [];

  for (const pin of opening) {
    if (openTab(pin.url)) removePin(pin);
    else blocked.push(pin);
  }

  if (blocked.length === 0) {
    if (opening.length > 0) notify(`${opening.length} 件をタブで開いた`);
    activeOverlay.value = null;
    return;
  }

  // 残った分を個別に開けるよう、一覧は閉じない
  notify(
    `${opening.length - blocked.length} 件を開いた。${blocked.length} 件はブラウザにブロックされた（ポップアップを許可すると全て開ける）`,
  );
}

/**
 * 新しいタブで開く。**開けたかどうかを返す。**
 *
 * noopener を付けて開くと、ブロックされていなくても戻り値が null になる（仕様）。
 * 判定したいので付けずに開き、開いた直後に opener を切る。
 * 参照を渡したままにすると、開いた先から元のタブを操作されうる
 */
function openTab(url: string): boolean {
  const opened = window.open(url, '_blank');
  if (opened === null) return false;
  opened.opener = null;
  return true;
}

/**
 * 元記事を開く（v）。openTab は使わない。
 * こちらは開けたかを知る必要が無いぶん、noreferrer まで付けて相手に渡す情報を減らせる
 * （noreferrer を付けると戻り値が null になり、開けたかの判定はできなくなる）
 */
function openOriginal(): void {
  const url = feeds.currentEntry?.url;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function onKeydown(event: KeyboardEvent): void {
  if (isTextInput(event.target)) return;
  const binding = resolveBinding(event);
  if (binding === null) return;
  // Space の既定のスクロールと衝突させないため、処理したものだけを止める
  if (handle(binding)) event.preventDefault();
}

/** 閉じ方（Esc / ? / 背景クリック）に依らず「見た」ことを記録する */
function closeOverlay(): void {
  if (activeOverlay.value === 'help') markHelpSeen();
  activeOverlay.value = null;
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  // キーボード前提の UI なので、知らないと何もできない。初回だけ自動で開く
  if (!hasSeenHelp()) activeOverlay.value = 'help';
  // 購読の依頼が載っていればそちらを優先する（ヘルプを見に来たのではない）
  takePendingSubscription();
  void session.boot();
});

onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <!--
    広い画面は左ペイン + 記事の 2 列（docs/UX.md「画面構成（PC）」）。
    狭い画面は記事ビューだけを出し、フィード一覧はヘッダから開く
    （docs/UX.md「画面構成（スマホ）」）
  -->
  <div
    class="h-dvh bg-white text-neutral-900 md:grid md:grid-cols-[18rem_1fr] dark:bg-neutral-950 dark:text-neutral-100"
  >
    <!--
      狭い画面では記事ビューに重ねる引き出しにする。開いていない間は組み立てない
      （記事送りのたびに、見えていない一覧の再描画に付き合わされないように）
    -->
    <FeedList
      v-if="!compact || drawerOpen"
      :class="compact ? 'fixed inset-0 z-20 bg-white dark:bg-neutral-950' : ''"
      :feeds="feeds.visibleFeeds"
      :current-feed-id="feeds.currentFeed?.id ?? null"
      :current-entry-id="feeds.currentEntry?.id ?? null"
      :entries-of="feeds.entriesFor"
      :pinned-urls="pins.urls"
      :compact="compact"
      :stalled-count="stalledCount"
      :folders="feeds.folders"
      :folder="feeds.folder"
      @select-entry="selectEntryIn"
      @manage="openManager"
      @unsubscribe="unsubscribeFeed"
      @close="drawerOpen = false"
      @select-folder="feeds.setFolder"
    />

    <main class="flex h-dvh flex-col overflow-hidden">
      <p
        v-if="session.error"
        class="shrink-0 bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      >
        サーバに繋がらないので手元のデータで表示している: {{ session.error }}
      </p>
      <p
        v-if="session.localError"
        class="shrink-0 bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100"
        data-testid="local-error"
      >
        {{ session.localError }}
      </p>
      <p
        v-if="notice"
        class="shrink-0 bg-neutral-200 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        data-testid="notice"
      >
        {{ notice }}
      </p>

      <!--
        **読み終えたときは範囲も明かす。** フォルダで絞っていると、範囲の外に未読が
        残っていても「全て読み終えた」としか読めない。狭い画面では絞り込みの表示が
        引き出しの中なので、なぜ止まったのかが画面上のどこにも無くなる
      -->
      <div
        v-if="feeds.finished"
        class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
        data-testid="finished"
      >
        <p class="text-sm text-neutral-500">
          {{
            feeds.folder === null
              ? '全て読み終えた'
              : `「${folderLabel(feeds.folder)}」は全て読み終えた`
          }}
        </p>
        <p v-if="feeds.unreadOutsideScope > 0" class="text-xs text-neutral-500">
          他のフォルダに未読が {{ feeds.unreadOutsideScope }} 件ある
        </p>
      </div>
      <div
        v-else-if="!feeds.started"
        class="flex h-full items-center justify-center"
        data-testid="empty"
      >
        <!-- 背景取得が終わるまでは「無い」と断定しない（初回起動は手元が空のため） -->
        <p class="text-sm text-neutral-500">
          {{
            session.phase === 'ready' || session.error ? '未読の記事がありません' : '読み込み中…'
          }}
        </p>
      </div>
      <template v-else>
        <!-- 現在位置はヘッダに固定する。本文と一緒にスクロールして消えないように -->
        <header
          class="shrink-0 border-b border-neutral-300 text-xs text-neutral-500 dark:border-neutral-700"
          data-testid="position"
        >
          <!--
            狭い画面ではヘッダ全体がフィード一覧の入口になる（docs/UX.md）。
            **指で押す前提の大きさにする。** 文字は本文と同じ列に並ぶ情報なので
            小さくしてあったが、それだと実機で狙いづらい
          -->
          <button
            v-if="compact"
            type="button"
            class="flex w-full items-center gap-2.5 px-3 py-3 text-left text-sm"
            data-testid="open-feed-list"
            @click="drawerOpen = true"
          >
            <span aria-hidden="true" class="text-lg leading-none">☰</span>
            <span
              v-if="stalledCount > 0"
              class="text-amber-700 dark:text-amber-500"
              data-testid="stalled-mark"
              title="取得が止まっているフィードがある"
              >!</span
            >
            <span class="truncate">{{ feedTitle }}</span>
            <span class="ml-auto shrink-0 tabular-nums"
              >({{ feeds.entryIndex + 1 }}/{{ feeds.entryCount }})</span
            >
          </button>
          <span v-else class="block px-6 py-1.5">
            ({{ feeds.entryIndex + 1 }}/{{ feeds.entryCount }}) {{ feedTitle }}
          </span>
        </header>
        <EntryReader
          ref="reader"
          class="min-h-0 flex-1"
          :entry="feeds.currentEntry"
          :pinned="currentPinned"
          @next="feeds.nextEntry()"
          @prev="feeds.prevEntry()"
        />
        <!--
          スマホのボトムバー。境界でラベルだけが変わる（docs/UX.md）。
          押す操作は j / k と同じ経路を通るので、キーとの食い違いが生まれない
        -->
        <BottomBar
          v-if="compact"
          :at-first-entry="atFirstEntry"
          :at-last-entry="atLastEntry"
          :pinned="currentPinned"
          :can-open="Boolean(feeds.currentEntry?.url)"
          @prev="feeds.prevEntry()"
          @next="feeds.nextEntry()"
          @open="openOriginal()"
          @pin="togglePin()"
        />
      </template>
    </main>

    <HelpOverlay v-if="activeOverlay === 'help'" @close="closeOverlay" />
    <SubscriptionManager
      v-if="activeOverlay === 'subscriptions'"
      :initial-url="pendingUrl"
      @close="
        activeOverlay = null;
        pendingUrl = null;
      "
    />
    <PinList
      v-if="activeOverlay === 'pins'"
      @close="activeOverlay = null"
      @remove="(pin) => removePin(pin)"
    />
  </div>
</template>
