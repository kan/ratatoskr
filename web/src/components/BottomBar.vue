<script setup lang="ts">
/**
 * 記事送りのバー（docs/UX.md「境界でのボタン変化」）。LDRoid の
 * updateButtons() の再現。
 *
 * **スマホと PC で同じものを出す（issue #6）。** 寸法だけ変える（PC は親指ではなく
 * マウスで押すので、縦の場所を食わない高さにする）。文言も振る舞いも同じにするのは、
 * どちらの画面でも「同じ場所を押し続ければ進む」という一点が中核だから。
 *
 * **ボタンは同じ位置に留まり、ラベルだけが変わる。** 最終記事なら「次のフィード」、
 * そうでなければ「次の記事」。押し続けるだけで記事 → 記事 → フィード → 記事… と
 * 全購読を消化でき、親指の位置を変える必要がない。ここを崩すと LDR 体験ではなくなる。
 *
 * カーソルは動かさない。押されたことを親に投げるだけ（CLAUDE.md の不変条件 2）。
 */
import { releaseKeyFocus } from '@/lib/keymap';

defineProps<{
  /** 先頭記事にいるか。「前へ」がフィード移動に変わる */
  atFirstEntry: boolean;
  /** 最終記事にいるか。「次へ」がフィード移動に変わる */
  atLastEntry: boolean;
  pinned: boolean;
  /** 元記事の URL があるか。無い記事では「開く」が効かない */
  canOpen: boolean;
}>();

defineEmits<{ prev: []; next: []; open: []; pin: [] }>();
</script>

<template>
  <!--
    safe-area の分だけ下に余白を足す。iPhone のホームバーに最下段のボタンが
    重なると、押したつもりが画面外に落ちる。

    押した後にフォーカスを残さない。**PC ではキーボードと同居する（issue #6）。**
    残すと、次に押した Space が本文送りではなくこのボタンの再発火になり、Enter は
    KEYMAP に無いので素通りして確実に再発火する。どちらも記事が 1 本進み、
    ウォーターマークで既読になる（App.vue のテーマ切り替えと同じ扱い）。

    ボタンごとに書かず、ここで 1 回受ける。押下は子から bubble し、event.target は
    押されたボタン自身になるので、ボタンを足したときの書き忘れが起きない
  -->
  <nav
    class="flex shrink-0 items-stretch border-t border-neutral-300 pb-[env(safe-area-inset-bottom)] text-sm md:text-xs dark:border-neutral-700"
    data-testid="bottom-bar"
    @click="releaseKeyFocus"
  >
    <button
      type="button"
      class="flex-1 px-1 py-3.5 md:py-1.5 text-xs whitespace-nowrap text-neutral-700 active:bg-neutral-200 dark:text-neutral-300 dark:active:bg-neutral-800"
      data-testid="bottom-prev"
      @click="$emit('prev')"
    >
      ◀ {{ atFirstEntry ? '前のフィード' : '前の記事' }}
    </button>
    <button
      type="button"
      class="w-12 shrink-0 py-3.5 md:py-1.5 text-neutral-700 active:bg-neutral-200 disabled:text-neutral-400 dark:text-neutral-300 dark:active:bg-neutral-800 dark:disabled:text-neutral-600"
      data-testid="bottom-open"
      :disabled="!canOpen"
      @click="$emit('open')"
    >
      開く
    </button>
    <!-- ピンは同じボタンで付け外しする（docs/UX.md）。立っているかは色で示し、
         文言は変えない。幅が動くと隣の「次へ」の位置がずれる -->
    <button
      type="button"
      class="w-12 shrink-0 py-3.5 md:py-1.5 active:bg-neutral-200 dark:active:bg-neutral-800"
      :class="
        pinned ? 'text-amber-600 dark:text-amber-500' : 'text-neutral-700 dark:text-neutral-300'
      "
      data-testid="bottom-pin"
      :aria-pressed="pinned"
      @click="$emit('pin')"
    >
      ピン
    </button>
    <!-- 「次へ」は右端に最大サイズで置く。最も親指が届く位置（docs/UX.md） -->
    <button
      type="button"
      class="flex-[1.6] border-l border-neutral-300 px-1 py-3.5 md:py-1.5 font-bold whitespace-nowrap active:bg-neutral-200 dark:border-neutral-700 dark:active:bg-neutral-800"
      data-testid="bottom-next"
      @click="$emit('next')"
    >
      {{ atLastEntry ? '次のフィード' : '次の記事' }} ▶
    </button>
  </nav>
</template>
