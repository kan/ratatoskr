<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Entry } from '@shared/types';

/**
 * 右ペイン。常に 1 記事だけを表示する。記事リストは作らない（docs/UX.md）。
 *
 * このコンポーネントはカーソルを動かさない。Space の境界判定に必要な
 * 「もう下端か」だけを親に返し、記事送りの判断は親（カーソルの所有者）が行う。
 */
const props = defineProps<{
  entry: Entry | null;
  /** この記事にピンが立っているか。目印を出すだけで、操作は親が持つ */
  pinned: boolean;
}>();

const scroller = ref<HTMLElement | null>(null);

// 前の記事のスクロール位置を持ち越さない。アニメーションは付けない（体感遅延になる）
watch(
  () => props.entry?.id,
  () => scroller.value?.scrollTo({ top: 0 }),
);

/** 1 画面分だけ重ねてスクロールする。読んでいた行が画面外に飛ばないように */
const OVERLAP = 40;

function atBottom(el: HTMLElement): boolean {
  // docs/UX.md に書かれた判定式そのまま
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
}

function atTop(el: HTMLElement): boolean {
  return el.scrollTop <= 0;
}

/** @returns スクロールできたか。false なら親が次の記事へ進める */
function pageDown(): boolean {
  const el = scroller.value;
  if (el === null || atBottom(el)) return false;
  el.scrollTop += Math.max(el.clientHeight - OVERLAP, 1);
  return true;
}

/** 前の記事に戻ったときに末尾から読み返せるようにする（Shift+Space の逆送り） */
function scrollToBottom(): void {
  const el = scroller.value;
  if (el !== null) el.scrollTop = el.scrollHeight;
}

/** @returns スクロールできたか。false なら親が前の記事へ戻る */
function pageUp(): boolean {
  const el = scroller.value;
  if (el === null || atTop(el)) return false;
  el.scrollTop -= Math.max(el.clientHeight - OVERLAP, 1);
  return true;
}

defineExpose({ pageDown, pageUp, scrollToBottom });
</script>

<template>
  <article
    ref="scroller"
    class="h-full overflow-y-auto px-5 py-5 sm:px-8 lg:px-12"
    data-testid="reader"
  >
    <!--
      本文の行長を抑える。広い画面で端から端まで文字が並ぶと、行を折り返すたびに
      目が横へ大きく振られて読み進めづらい。44rem はおよそ全角 44 字ぶん
    -->
    <div class="mx-auto w-full max-w-[44rem]">
      <template v-if="entry">
        <h1 class="text-2xl font-bold">
          <!-- ピンは目立たせない。読む邪魔をせず、目印として分かればよい。
               タイトルの中には入れない（見出しの文言そのものを変えないため） -->
          <span
            v-if="pinned"
            class="mr-1 align-middle text-sm text-amber-600 dark:text-amber-500"
            data-testid="entry-pinned"
            title="ピン済み"
            >📌</span
          ><span data-testid="entry-title">{{ entry.title || '(無題)' }}</span>
        </h1>
        <p class="mt-1.5 text-xs text-neutral-500">
          <span v-if="entry.author">{{ entry.author }} / </span>
          <span v-if="entry.publishedAt">{{
            new Date(entry.publishedAt * 1000).toLocaleString('ja-JP')
          }}</span>
        </p>
        <hr class="my-4 border-neutral-300 dark:border-neutral-700" />
        <!-- body は取り込み時にサーバ側でサニタイズ済み（CLAUDE.md の不変条件 4） -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="article-body" v-html="entry.body"></div>
      </template>
      <p v-else class="text-sm text-neutral-500">記事がありません</p>
    </div>
  </article>
</template>
