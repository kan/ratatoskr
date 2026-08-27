<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Entry } from '@shared/types';
import { repairBrokenImage } from '@/lib/image-repair';
import { classifySwipe, pullsPastBottom } from '@/lib/swipe';

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
  /**
   * 出す記事が無いときの文言。**読み込み中と区別が付くのは親だけ**なので、
   * 文言そのものを受け取る（起動の途中は「無い」と断定しない。issue #10）
   */
  emptyLabel: string;
}>();

/**
 * 左右スワイプは j / k と同じ移動要求として上に投げる（docs/UX.md）。
 * 境界でフィードを跨ぐかどうかも含めて、判断はカーソルの所有者が持つ
 */
const emit = defineEmits<{ next: []; prev: [] }>();

/**
 * 画像が読めなかったときだけ動く。壊れた控えを捨てて 1 回だけ取り直す
 * （lib/image-repair.ts）。**`error` は bubble しない**ので、キャプチャで拾う
 */
function onLoadError(event: Event): void {
  if (event.target instanceof HTMLImageElement) repairBrokenImage(event.target);
}

const scroller = ref<HTMLElement | null>(null);

// 前の記事のスクロール位置を持ち越さない。アニメーションは付けない（体感遅延になる）
watch(
  () => props.entry?.id,
  () => {
    scroller.value?.scrollTo({ top: 0 });
    resetPull();
  },
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

/** 指を置いた位置。1 本指で、横スクロールする入れ物の外から始まったものだけ見る */
let touchStart: { x: number; y: number } | null = null;

/**
 * 下端に着いた時点の指の位置。ここからの引きが記事送りの量になる。
 *
 * 指を置いた位置から測らない。本文の途中から下端まで一息に送る動きは普通なので、
 * 全体の移動量で測ると「最後まで送っただけ」で次の記事に飛ぶ。
 */
let pullFrom: { x: number; y: number } | null = null;

/** 離せば次の記事に進む状態か。指に追従させる代わりに、進む先を文字で出す */
const pulling = ref(false);

function resetPull(): void {
  pullFrom = null;
  pulling.value = false;
}

/**
 * 横スクロールする入れ物（pre / table）の中から始まった指は記事送りにしない。
 * 表やコード片を横に送るつもりの指で記事が飛ぶと、読み返す手立てが無くなる
 * （docs/UX.md「そのブロックだけ横スクロール可能にする」）。
 */
function inHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el !== null && el !== scroller.value) {
    if (el.scrollWidth > el.clientWidth + 1) return true;
    el = el.parentElement;
  }
  return false;
}

function onTouchStart(event: TouchEvent): void {
  resetPull();
  // 2 本目の指が触れた時点で捨てる（拡大の操作を記事送りにしない）
  if (event.touches.length !== 1 || inHorizontalScroller(event.target)) {
    touchStart = null;
    return;
  }
  const touch = event.touches[0];
  touchStart = { x: touch.clientX, y: touch.clientY };

  // 既に下端にいるなら、指を置いた場所がそのまま引きの起点。最初の touchmove を
  // 待つと、そこまでに引いた分（実機では数 px、勢いよく引けばもっと）が捨てられる
  if (scroller.value !== null && atBottom(scroller.value)) pullFrom = { ...touchStart };
}

/**
 * 下端に着いた後の引きを測る（docs/UX.md「下端でさらに引くと次の記事」）。
 *
 * Space が下端で記事送りに変わるのと同じ考え方で、読み進める向きの動きを
 * そのまま続けると次に進む。スクロールは妨げない（preventDefault しない）。
 */
function onTouchMove(event: TouchEvent): void {
  const el = scroller.value;
  if (touchStart === null || el === null || event.touches.length !== 1) return;

  if (!atBottom(el)) {
    // まだ本文が残っている。下端に着き直したら測り直す
    resetPull();
    return;
  }

  const touch = event.touches[0];
  // 本文の途中から下端まで送ってきた指は、着いた時点を起点にする
  pullFrom ??= { x: touch.clientX, y: touch.clientY };
  pulling.value = pullsPastBottom(touch.clientX - pullFrom.x, touch.clientY - pullFrom.y);
}

/** 通知や別のジェスチャに取られた指は無かったことにする */
function onTouchCancel(): void {
  touchStart = null;
  resetPull();
}

function onTouchEnd(event: TouchEvent): void {
  const from = touchStart;
  const pulled = pulling.value;
  touchStart = null;
  resetPull();
  if (from === null || event.changedTouches.length !== 1) return;

  // 下端からの引きが先。横に流れた指はここに来ない（判定の割合が対称）
  if (pulled) {
    emit('next');
    return;
  }

  const touch = event.changedTouches[0];
  const direction = classifySwipe(touch.clientX - from.x, touch.clientY - from.y);
  if (direction === 'next') emit('next');
  else if (direction === 'prev') emit('prev');
}

defineExpose({ pageDown, pageUp, scrollToBottom });
</script>

<template>
  <div class="relative">
    <article
      ref="scroller"
      class="h-full overflow-y-auto overscroll-y-contain px-5 py-5 sm:px-8 lg:px-12"
      data-testid="reader"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
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
          <div class="article-body" @error.capture="onLoadError" v-html="entry.body"></div>
        </template>
        <p v-else class="text-sm text-neutral-500">{{ emptyLabel }}</p>
      </div>
    </article>

    <!--
      下端でさらに引いている間だけ出す。指に本文を追従させる代わりに、離したら
      何が起きるかを文字で出す（記事の切り替えにアニメーションは付けない。docs/UX.md）。

      **本文の中には置かない。** 出した分だけ本文が伸びて「もう下端ではない」状態に
      なり、出したり消したりを繰り返す。重ねて出せば、引きの判定は本文の高さに響かない
    -->
    <p
      v-if="pulling"
      class="pointer-events-none absolute inset-x-0 bottom-0 border-t border-neutral-300 bg-white/90 py-2 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950/90"
      data-testid="pull-hint"
    >
      離すと次の記事へ
    </p>
  </div>
</template>
