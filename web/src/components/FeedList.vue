<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { Entry, Feed } from '@shared/types';
import { isRead } from '@/stores/entries';

/**
 * 左ペイン。並びはサーバが返した順（レート降順 → 未読数降順）をそのまま使う。
 * この順序が読む順序であり、先読み順序でもある（docs/DESIGN.md）。
 *
 * フィード名を押すと記事一覧を開閉する。読んでいる最中のフィードは自動で開き、
 * 離れれば閉じる。手で開いたものは、閉じるまで開いたままにする（読んでいる場所を
 * 見失わずに他のフィードを覗けるように）。
 *
 * 表示するだけで、カーソルは動かさない。移動要求はイベントとして上に投げる
 * （CLAUDE.md の不変条件 2）。
 */
const props = defineProps<{
  feeds: Feed[];
  currentFeedId: number | null;
  currentEntryId: number | null;
  /** そのフィードの下に並べる記事。読んでいる最中のフィードだけ扱いが違う */
  entriesOf: (feedId: number) => Entry[];
}>();

defineEmits<{ selectEntry: [feedId: number, entryId: number]; manage: [] }>();

const nav = ref<HTMLElement | null>(null);

/** 手で開いたフィード。カーソルが離れても閉じない */
const opened = ref(new Set<number>());
/**
 * 読んでいる最中のフィードを手で畳んだ状態。
 * **カーソルが動いたら解除する。** 記事を送っている最中に一覧が出てこないと、
 * どこを読んでいるのか分からなくなる（畳むのはその場で邪魔なときの一時的な操作）。
 */
const closedCurrent = ref(false);

watch(
  () => [props.currentFeedId, props.currentEntryId],
  () => {
    closedCurrent.value = false;
  },
);

function isExpanded(feed: Feed): boolean {
  if (feed.id === props.currentFeedId) return !closedCurrent.value;
  return opened.value.has(feed.id);
}

function toggle(feed: Feed): void {
  if (feed.id === props.currentFeedId) {
    closedCurrent.value = !closedCurrent.value;
    return;
  }
  if (opened.value.has(feed.id)) opened.value.delete(feed.id);
  else opened.value.add(feed.id);
}

/**
 * 読んだ記事は暗く、まだ読んでいない記事は通常の明るさで出す。
 * 既読判定はウォーターマーク（id <= read_seq）そのもの。記事ごとの既読フラグは無い
 */
function entryClass(feed: Feed, entry: Entry): string {
  if (entry.id === props.currentEntryId) {
    return 'border-amber-600 bg-neutral-100 font-bold dark:border-amber-500 dark:bg-neutral-900';
  }
  return isRead(entry.id, feed.readSeq)
    ? 'border-transparent text-neutral-400 dark:text-neutral-600'
    : 'border-transparent text-neutral-700 dark:text-neutral-300';
}

// カーソルが動いたら、その行を見える位置に保つ。
// アニメーションは付けない（記事送りの体感遅延になる。docs/UX.md）
watch(
  () => [props.currentFeedId, props.currentEntryId],
  async () => {
    await nextTick();
    nav.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<template>
  <nav ref="nav" class="h-full overflow-y-auto border-r border-neutral-300 dark:border-neutral-700">
    <!--
      購読管理への入口。キーは割り当てない（docs/UX.md のキー表に無いものを増やさない）。
      読んでいる最中に使う機能ではないので、ここに置いておけば足りる
    -->
    <div class="flex items-center justify-between px-3 py-1.5 text-xs text-neutral-500">
      <span>Ratatoskr</span>
      <button
        type="button"
        class="hover:underline"
        data-testid="open-manager"
        @click="$emit('manage')"
      >
        購読管理
      </button>
    </div>
    <ul>
      <li v-for="feed in feeds" :key="feed.id">
        <button
          type="button"
          class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-200 dark:hover:bg-neutral-800"
          :class="{
            // 記事一覧が長くなるので、読んでいるフィード名は上に貼り付けておく
            'sticky top-0 z-1 bg-neutral-200 font-bold dark:bg-neutral-800':
              feed.id === currentFeedId,
            'text-neutral-500 dark:text-neutral-500': feed.unreadCount === 0,
          }"
          :data-testid="`feed-${feed.id}`"
          :data-active="feed.id === currentFeedId && currentEntryId === null ? 'true' : undefined"
          :data-expanded="isExpanded(feed) ? 'true' : undefined"
          :aria-current="feed.id === currentFeedId ? 'true' : undefined"
          :aria-expanded="isExpanded(feed)"
          @click="toggle(feed)"
        >
          <span class="w-3 shrink-0 text-xs text-neutral-400 dark:text-neutral-600">
            {{ isExpanded(feed) ? '▾' : '▸' }}
          </span>
          <!-- 未読 0 のフィードは (0) を出さない（docs/UX.md） -->
          <span class="w-10 shrink-0 text-right tabular-nums">
            {{ feed.unreadCount > 0 ? `(${feed.unreadCount})` : '' }}
          </span>
          <span class="truncate">{{ feed.title || feed.url }}</span>
        </button>

        <ul v-if="isExpanded(feed)" :data-testid="`entry-list-${feed.id}`">
          <li v-for="(entry, index) in entriesOf(feed.id)" :key="entry.id">
            <button
              type="button"
              class="block w-full truncate border-l-2 py-1 pr-3 pl-8 text-left text-xs hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :class="entryClass(feed, entry)"
              :data-testid="`entry-${entry.id}`"
              :data-active="entry.id === currentEntryId ? 'true' : undefined"
              :data-read="isRead(entry.id, feed.readSeq) ? 'true' : undefined"
              @click="$emit('selectEntry', feed.id, entry.id)"
            >
              <span class="mr-1.5 tabular-nums">{{ index + 1 }}</span>
              {{ entry.title || '(無題)' }}
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
