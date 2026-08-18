<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import EntryReader from '@/components/EntryReader.vue';
import FeedList from '@/components/FeedList.vue';
import HelpOverlay from '@/components/HelpOverlay.vue';
import { isTextInput, resolveAction, type Action } from '@/lib/keymap';
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
const activeOverlay = ref<'help' | null>(null);

const feedTitle = computed(() => feeds.currentFeed?.title ?? '');

function handle(action: Action): void {
  // オーバーレイを開いている間は閉じる操作だけを受け付ける
  if (activeOverlay.value !== null) {
    if (action === 'closeOverlay' || action === 'toggleHelp') closeOverlay();
    return;
  }

  switch (action) {
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

function openOriginal(): void {
  const url = feeds.currentEntry?.url;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function onKeydown(event: KeyboardEvent): void {
  if (isTextInput(event.target)) return;
  const action = resolveAction(event);
  if (action === null) return;
  // Space の既定のスクロールと衝突させない
  event.preventDefault();
  handle(action);
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
    />

    <main class="flex h-dvh flex-col overflow-hidden">
      <p
        v-if="session.error"
        class="shrink-0 bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      >
        サーバに繋がらないので手元のデータで表示している: {{ session.error }}
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
  </div>
</template>
