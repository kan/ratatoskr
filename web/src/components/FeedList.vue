<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Entry, Feed } from '@shared/types';
import FeedEntries from '@/components/FeedEntries.vue';
import { releaseKeyFocus } from '@/lib/keymap';
import { folderLabel } from '@/lib/subscriptions';

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
  /**
   * 狭い画面か。この一覧が記事ビューに重ねる引き出しになる
   * （docs/UX.md「画面構成（スマホ）」）。
   *
   * 変わるのは 2 つ。一覧から手ぶらで戻れるよう閉じる操作を出すことと、
   * **触る画面には hover が無い**ので、普段は透明にしている解除を最初から出すこと
   */
  compact?: boolean;
  /**
   * 取得が止まったフィードの数（M9）。**絞り込みの外も数えた値を受け取る。**
   * 購読の健全さの話であって、いま読んでいる範囲の話ではない
   */
  stalledCount: number;
  /** 使われているフォルダ名。絞り込みの選択肢（issue #3） */
  folders: string[];
  /** いま絞り込んでいるフォルダ。null は絞り込み無し */
  folder: string | null;
}>();

const emit = defineEmits<{
  selectEntry: [feedId: number, entryId: number];
  manage: [];
  /** 引き出しを閉じる（狭い画面のみ） */
  close: [];
  /** 読んでいる最中に「もう要らない」と判断したフィードの解除（issue #2） */
  unsubscribe: [feedId: number];
  /** 読む対象をフォルダで絞る。null は絞り込み無し（issue #3） */
  selectFolder: [folder: string | null];
}>();

/**
 * 絞り込みの選択。**null（すべて）と ''（未分類）を区別する必要がある**ので、
 * v-model に値をそのまま載せる（Vue は option の :value に文字列以外も通せる）。
 * 番兵の文字列を置くと、その文字列と同じ名前のフォルダを作られた瞬間に壊れる
 */
const selectedFolder = computed({
  get: () => props.folder,
  set: (value: string | null) => emit('selectFolder', value),
});

/** スクロールする入れ物。カーソルの行をこの中のどこに置くかを revealActive が決める */
const list = ref<HTMLElement | null>(null);

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

/**
 * 現在地の前後に見えていてほしい行数（issue #5）。
 *
 * **最小限のスクロールにすると、読み進めるたびに現在地が下端に貼り付く。**
 * 次に何が来るかが見えないので、フィードの終わりが近いことにも気付けない。
 * 行の高さはフィード名と記事で違うので、いま居る行の高さを 1 行分とみなす。
 */
const LOOKAHEAD = 3;

/** カーソルの行を、前後に余白を残した位置に置く */
function revealActive(): void {
  const box = list.value;
  const row = box?.querySelector<HTMLElement>('[data-active="true"]') ?? null;
  if (box === null || row === null) return;

  const boxRect = box.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const margin = rowRect.height * LOOKAHEAD;
  const below = boxRect.bottom - rowRect.bottom;
  const above = rowRect.top - boxRect.top;

  // 足りない方へ寄せる。両方足りない（一覧が余白より低い）ときは下を優先する。
  // 読む向きは下なので、次に来るものが見えている方が役に立つ。
  //
  // **寄せ幅は反対側の余白で頭打ちにする。** 入れ物が 4 行ぶんより低いと、
  // 余白を空けようとしてカーソルの行そのものを画面の外へ押し出してしまう
  if (below < margin) box.scrollTop += Math.min(margin - below, Math.max(above, 0));
  else if (above < margin) box.scrollTop -= Math.min(margin - above, Math.max(below, 0));
}

// カーソルが動いたら、その行を見える位置に保つ。
// アニメーションは付けない（記事送りの体感遅延になる。docs/UX.md）
//
// **組み立てた直後にも 1 回走らせる。** 狭い画面の引き出しは開くたびに作り直されるので、
// 変化を待っていると、いつも一覧の先頭が出て現在地が画面の外に居る
watch(
  () => [props.currentFeedId, props.currentEntryId],
  async () => {
    await nextTick();
    revealActive();
  },
  { immediate: true },
);
</script>

<template>
  <!--
    overflow-hidden は見た目のためではなく、高さを決めるために要る。**スクロール
    コンテナの自動最小高さは 0 になる**ので、これが無いとグリッドの行が中身の高さ
    （購読の数だけ伸びる）まで広がり、h-full が画面の高さに収まらなくなる
  -->
  <nav
    class="flex h-full flex-col overflow-hidden border-r border-neutral-300 dark:border-neutral-700"
  >
    <!--
      購読管理への入口。キーは割り当てない（docs/UX.md のキー表に無いものを増やさない）。
      **スクロールの外に置く。** 一覧は購読の数だけ伸びるので、中に入れると
      下まで読み進めたときに入口が画面の外へ消える
    -->
    <div
      class="flex shrink-0 items-center justify-between border-b border-neutral-200 px-3 py-3 text-base text-neutral-500 md:py-2 md:text-sm dark:border-neutral-800"
    >
      <span>Ratatoskr</span>
      <span class="flex items-center gap-3">
        <button
          type="button"
          class="hover:underline"
          data-testid="open-manager"
          @click="$emit('manage')"
        >
          購読管理
        </button>
        <button
          v-if="compact"
          type="button"
          class="py-1 hover:underline"
          data-testid="close-feed-list"
          @click="$emit('close')"
        >
          閉じる
        </button>
      </span>
    </div>

    <!--
      フォルダでの絞り込み（issue #3。方針は docs/UX.md の「フォルダ」）。

      **横並びにはしない。** サイドバーの幅では必ず横スクロールになり、選択中の
      ものが見えないことがある。選ぶものが 1 つしか無いなら出さない
    -->
    <div
      v-if="folders.length > 1"
      class="shrink-0 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800"
    >
      <!--
        **地色と文字色は明示する。** bg-transparent にすると、展開したリストの地色だけが
        ブラウザ既定（白）に落ちて文字色は継承のままになり、暗いテーマで未選択の項目が
        読めなくなる
      -->
      <select
        v-model="selectedFolder"
        class="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 md:text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        data-testid="folder-filter"
        aria-label="読む対象のフォルダ"
        @change="releaseKeyFocus"
      >
        <!-- 見出しを別に置くと、その分だけ一覧が狭くなる。文言だけで何の選択かを伝える -->
        <option :value="null">すべてのフォルダ</option>
        <option v-for="name in folders" :key="name" :value="name">{{ folderLabel(name) }}</option>
      </select>
    </div>

    <!-- スクロールするのはここから下だけ。読んでいるフィード名の sticky もこの中で効く -->
    <div ref="list" data-testid="feed-list" class="subtle-scrollbar min-h-0 flex-1 overflow-y-auto">
      <!--
        押すと購読管理へ。直すにも解除するにもそこでしかできないので、
        知らせと入口を分けない
      -->
      <button
        v-if="stalledCount > 0"
        type="button"
        class="block w-full bg-amber-100 px-3 py-2 text-left text-sm text-amber-900 hover:underline md:py-1.5 md:text-xs dark:bg-amber-950 dark:text-amber-100"
        data-testid="stalled-feeds"
        @click="$emit('manage')"
      >
        取得が止まっているフィードが {{ stalledCount }} 件ある
      </button>

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
              class="flex min-w-0 flex-1 items-baseline gap-2 py-2.5 pl-3 text-left text-lg md:py-1.5 md:text-base"
              :class="{
                'font-bold': feed.id === currentFeedId,
                'text-neutral-500 dark:text-neutral-500': feed.unreadCount === 0,
              }"
              :data-testid="`feed-${feed.id}`"
              :data-active="
                feed.id === currentFeedId && currentEntryId === null ? 'true' : undefined
              "
              :data-expanded="isExpanded(feed) ? 'true' : undefined"
              :aria-current="feed.id === currentFeedId ? 'true' : undefined"
              :aria-expanded="isExpanded(feed)"
              @click="toggle(feed)"
            >
              <span class="w-3 shrink-0 text-sm text-neutral-400 md:text-xs dark:text-neutral-600">
                {{ isExpanded(feed) ? '▾' : '▸' }}
              </span>
              <!-- 未読 0 のフィードは (0) を出さない（docs/UX.md） -->
              <span class="w-14 shrink-0 text-right tabular-nums md:w-12">
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
              class="shrink-0 px-3 py-2.5 text-sm hover:!text-red-700 focus-visible:text-neutral-500 md:px-2 md:py-1.5 md:text-xs dark:hover:!text-red-400"
              :class="
                compact
                  ? 'text-neutral-500 dark:text-neutral-400'
                  : 'text-transparent group-hover:text-neutral-500 dark:group-hover:text-neutral-400'
              "
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
    </div>
  </nav>
</template>
