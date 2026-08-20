<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { Entry, Feed } from '@shared/types';
import FeedEntries from '@/components/FeedEntries.vue';

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
  /** ピンの立っている記事の url。一覧に目印を出すために引く */
  pinnedUrls: Set<string>;
}>();

defineEmits<{
  selectEntry: [feedId: number, entryId: number];
  manage: [];
  /** 読んでいる最中に「もう要らない」と判断したフィードの解除（issue #2） */
  unsubscribe: [feedId: number];
}>();

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
    // 手で開いた記録も落とす。残すと、カーソルが離れた瞬間に
    // 「いま畳んだはずのフィード」が開き直る
    if (closedCurrent.value) opened.value.delete(feed.id);
    return;
  }
  if (opened.value.has(feed.id)) opened.value.delete(feed.id);
  else opened.value.add(feed.id);
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
        <div
          class="group flex items-center hover:bg-neutral-200 dark:hover:bg-neutral-800"
          :class="{
            // 記事一覧が長くなるので、読んでいるフィード名は上に貼り付けておく
            'sticky top-0 z-1 bg-neutral-200 dark:bg-neutral-800': feed.id === currentFeedId,
          }"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 pl-3 text-left text-sm"
            :class="{
              'font-bold': feed.id === currentFeedId,
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
          <!--
            読んでいる最中の解除（issue #2）。キーは割り当てない（docs/UX.md の
            キー表に無いものを増やさない）。普段は文字色を透明にして場所だけ取り、
            行に触れたときに出す。出したり消したりで幅が動くと、フィード名の
            折り返し位置が変わって読みにくい
          -->
          <button
            type="button"
            class="shrink-0 px-2 py-1.5 text-xs text-transparent group-hover:text-neutral-500 hover:!text-red-700 focus-visible:text-neutral-500 dark:group-hover:text-neutral-400 dark:hover:!text-red-400"
            :data-testid="`feed-unsubscribe-${feed.id}`"
            :title="`「${feed.title || feed.url}」の購読を解除する`"
            @click="$emit('unsubscribe', feed.id)"
          >
            解除
          </button>
        </div>

        <!--
          読んでいる最中でないフィードには currentEntryId を渡さない。
          そのフィードの記事が現在の記事であることは無く、渡すと記事送りのたびに
          開いている一覧が全て再描画される
        -->
        <FeedEntries
          v-if="isExpanded(feed)"
          :feed="feed"
          :current-entry-id="feed.id === currentFeedId ? currentEntryId : null"
          :entries-of="entriesOf"
          :pinned-urls="pinnedUrls"
          @select="(entryId) => $emit('selectEntry', feed.id, entryId)"
        />
      </li>
    </ul>
  </nav>
</template>
