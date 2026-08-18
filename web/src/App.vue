<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import EntryReader from '@/components/EntryReader.vue';
import FeedList from '@/components/FeedList.vue';
import HelpOverlay from '@/components/HelpOverlay.vue';
import SubscriptionManager from '@/components/SubscriptionManager.vue';
import { isTextInput, resolveBinding, type KeyBinding } from '@/lib/keymap';
import { hasSeenHelp, markHelpSeen } from '@/lib/prefs';
import { useFeedsStore } from '@/stores/feeds';
import { useSessionStore } from '@/stores/session';

/**
 * キー入力の受け口はここ 1 箇所だけ。個別のコンポーネントに keydown を散らさない
 * （CLAUDE.md）。押されたキーは keymap.ts が Action に落とし、ここは Action に
 * 対する処理だけを書く。
 */
const feeds = useFeedsStore();
const session = useSessionStore();

const reader = ref<InstanceType<typeof EntryReader> | null>(null);

// オーバーレイは「いま何が開いているか」で持つ。ピン一覧（M6）が増えたときに
// 表示中フラグを増やさずに済ませるため
const activeOverlay = ref<'help' | 'subscriptions' | null>(null);

const feedTitle = computed(() => feeds.currentFeed?.title ?? '');

/** 手動更新のように、画面が変わらないことのある操作の結果を出す場所 */
const notice = ref<string | null>(null);

/**
 * 押されたキーを処理する。処理したかどうかを返す。
 *
 * 返り値で preventDefault の要否を分けるのは、購読管理のようなフォーム UI を
 * 開いている間にブラウザ既定の操作（Space でのボタン押下、Tab 移動）を
 * 奪わないため。読んでいる間は Space を必ず横取りする（既定のスクロールと衝突する）。
 */
function handle(binding: KeyBinding): boolean {
  // オーバーレイを開いている間は閉じる操作だけを受け付ける
  if (activeOverlay.value !== null) {
    if (binding.action !== 'closeOverlay' && binding.action !== 'toggleHelp') return false;
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

  notice.value = '取得中…';
  session
    .refresh(id)
    .then((added) => {
      notice.value = added === 0 ? '新着は無かった' : `${added} 件の新着を取得した`;
    })
    .catch((err: unknown) => {
      notice.value = `更新に失敗した: ${err instanceof Error ? err.message : String(err)}`;
    });
}

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
  void session.boot();
});

onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="grid h-dvh grid-cols-[18rem_1fr] bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
  >
    <FeedList
      :feeds="feeds.feeds"
      :current-feed-id="feeds.currentFeed?.id ?? null"
      :entries="feeds.currentEntries"
      :current-entry-id="feeds.currentEntry?.id ?? null"
      @select="feeds.selectFeed"
      @select-entry="feeds.selectEntry"
      @manage="activeOverlay = 'subscriptions'"
    />

    <main class="flex h-dvh flex-col overflow-hidden">
      <p
        v-if="session.error"
        class="shrink-0 bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      >
        サーバに繋がらないので手元のデータで表示している: {{ session.error }}
      </p>
      <p
        v-if="notice"
        class="shrink-0 bg-neutral-200 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        data-testid="notice"
      >
        {{ notice }}
      </p>

      <div
        v-if="feeds.finished"
        class="flex h-full items-center justify-center"
        data-testid="finished"
      >
        <p class="text-sm text-neutral-500">全て読み終えた</p>
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
          class="shrink-0 border-b border-neutral-300 px-6 py-1.5 text-xs text-neutral-500 dark:border-neutral-700"
          data-testid="position"
        >
          ({{ feeds.entryIndex + 1 }}/{{ feeds.entryCount }}) {{ feedTitle }}
        </header>
        <EntryReader ref="reader" class="min-h-0 flex-1" :entry="feeds.currentEntry" />
      </template>
    </main>

    <HelpOverlay v-if="activeOverlay === 'help'" @close="closeOverlay" />
    <SubscriptionManager v-if="activeOverlay === 'subscriptions'" @close="activeOverlay = null" />
  </div>
</template>
