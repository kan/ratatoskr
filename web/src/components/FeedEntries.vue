<script setup lang="ts">
import { computed } from 'vue';
import type { Entry, Feed } from '@shared/types';
import { isRead } from '@/stores/entries';

/**
 * 左ペインで開いているフィードの記事一覧。
 *
 * **これを FeedList から切り出しているのは、記事送りのたびに全部を計算し直さない
 * ため。** 開いたフィードは複数あってよいので、カーソルが動くたびに開いている数だけ
 * 未読の絞り込みが走ると、記事送りの経路に無駄が積み上がる。コンポーネントを分けると
 * 一覧は computed に載り、自分のフィードのデータが変わったときだけ計算される。
 *
 * 読んでいる最中でないフィードには currentEntryId が渡らない（そのフィードの記事が
 * 現在の記事であることは無い）ので、記事送りでは再描画そのものが起きない。
 */
const props = defineProps<{
  feed: Feed;
  /** 読んでいる最中のフィードにだけ渡る。それ以外は null */
  currentEntryId: number | null;
  entriesOf: (feedId: number) => Entry[];
  /** ピンの立っている記事の url */
  pinnedUrls: Set<string>;
}>();

defineEmits<{ select: [entryId: number] }>();

const entries = computed(() => props.entriesOf(props.feed.id));

/**
 * 読んだ記事は暗く、まだ読んでいない記事は通常の明るさで出す。
 * 既読判定はウォーターマーク（id <= read_seq）そのもの。記事ごとの既読フラグは無い
 */
function isPinned(entry: Entry): boolean {
  return entry.url !== null && props.pinnedUrls.has(entry.url);
}

function entryClass(entry: Entry): string {
  if (entry.id === props.currentEntryId) {
    return 'border-amber-600 bg-neutral-100 font-bold dark:border-amber-500 dark:bg-neutral-900';
  }
  return isRead(entry.id, props.feed.readSeq)
    ? 'border-transparent text-neutral-400 dark:text-neutral-600'
    : 'border-transparent text-neutral-700 dark:text-neutral-300';
}
</script>

<template>
  <ul :data-testid="`entry-list-${feed.id}`">
    <li v-for="(entry, index) in entries" :key="entry.id">
      <button
        type="button"
        class="block w-full truncate border-l-2 py-1 pr-3 pl-8 text-left text-xs hover:bg-neutral-200 dark:hover:bg-neutral-800"
        :class="entryClass(entry)"
        :data-testid="`entry-${entry.id}`"
        :data-active="entry.id === currentEntryId ? 'true' : undefined"
        :data-read="isRead(entry.id, feed.readSeq) ? 'true' : undefined"
        @click="$emit('select', entry.id)"
      >
        <span class="mr-1.5 tabular-nums">{{ index + 1 }}</span>
        <!-- ピンの目印。数字の並びを崩さないよう、タイトル側に小さく出す -->
        <span v-if="isPinned(entry)" :data-testid="`pinned-${entry.id}`" title="ピン済み">📌</span>
        {{ entry.title || '(無題)' }}
      </button>
    </li>
  </ul>
</template>
