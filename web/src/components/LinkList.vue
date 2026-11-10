<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { LinkRow } from '@/lib/links';

/**
 * 記事内のリンク一覧（l、issue #32）。記事そのものではなく、記事が参照している先を
 * ピンするための場所。行の組み立ては lib/links.ts。
 *
 * **選んでいる行はここが持つが、キーは受けない。** キー入力の受け口は App.vue の
 * 1 箇所だけで（CLAUDE.md）、j / k / Enter / p はそこから move / selected で届く。
 */

const props = defineProps<{
  rows: LinkRow[];
  /** 画面に出ているピンの url（stores/pins.ts の shownUrls） */
  pinnedUrls: Set<string>;
}>();

defineEmits<{ close: []; open: [row: LinkRow]; pin: [row: LinkRow] }>();

const index = ref(0);
const list = ref<HTMLElement | null>(null);

/**
 * 開いている間に行が変わったら（全文が後から届いて本文が差し替わった）、選んでいた
 * URL の行に付いていく。位置のままにすると、同じ場所の別のリンクを p でピンする。
 * 行が消えていれば先頭に戻す
 */
watch(
  () => props.rows,
  (next, before) => {
    const url = before[index.value]?.url;
    const found = next.findIndex((row) => row.url === url);
    index.value = found >= 0 ? found : 0;
  },
);

/** 端で止める（巡回させない）。端から反対側へ飛ぶと、押しすぎたときに位置を見失う */
function move(delta: number): void {
  if (props.rows.length === 0) return;
  index.value = Math.min(Math.max(index.value + delta, 0), props.rows.length - 1);
}

function selected(): LinkRow | null {
  return props.rows[index.value] ?? null;
}

// 選んだ行を見える位置に保つ。一覧が長いと、j で送った先が画面の外に出る。
// 行は描いた後の印（data-selected）で引く。v-for の ref の配列は並びが保証されない
watch(index, async () => {
  await nextTick();
  list.value?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' });
});

defineExpose({ move, selected });
</script>

<template>
  <div
    class="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
    data-testid="link-list"
    @click.self="$emit('close')"
  >
    <div class="w-full max-w-2xl rounded bg-white p-5 text-sm shadow-lg dark:bg-neutral-900">
      <!-- 閉じるのはボタンでも出す（スマホには Esc も l も無い。PinList と同じ） -->
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-base font-bold">リンク</h2>
        <button
          type="button"
          class="shrink-0 text-xs text-neutral-500 hover:underline"
          data-testid="link-close"
          @click="$emit('close')"
        >
          閉じる（Esc）
        </button>
      </div>

      <p v-if="rows.length === 0" class="mt-4 text-xs text-neutral-500" data-testid="link-empty">
        この記事にはリンクが無い
      </p>

      <!-- 行は狭い画面で厚くする。指が隣の行のボタンを巻き込まないように（PinList と同じ） -->
      <ul v-else ref="list" class="mt-3">
        <li
          v-for="(row, i) in rows"
          :key="row.url"
          class="flex items-baseline gap-3 border-t border-l-2 border-t-neutral-200 py-3 pl-2 md:py-1.5 dark:border-t-neutral-800"
          :class="
            i === index ? 'border-l-amber-600 dark:border-l-amber-500' : 'border-l-transparent'
          "
          :data-testid="`link-${i}`"
          :data-selected="i === index ? 'true' : undefined"
          @click="index = i"
        >
          <!-- 押した行も選んだことにする（中のリンクやボタンの click が上がってくる）。
               続けて j / k で隣へ動けるように -->
          <span v-if="row.self" class="shrink-0 text-xs text-neutral-500">この記事</span>
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
            class="min-w-0 flex-1 truncate hover:underline"
            :title="row.url"
          >
            {{ row.text || row.url }}
          </a>
          <button
            type="button"
            class="shrink-0 py-2.5 pl-3 text-xs text-neutral-500 hover:underline md:py-1.5 md:pl-2"
            :data-testid="`link-open-${i}`"
            @click="$emit('open', row)"
          >
            開く
          </button>
          <!-- ピンの有無は色で出す（ボトムバーの「ピン」と同じ）。文言を変えると幅が動く -->
          <button
            type="button"
            class="shrink-0 py-2.5 pl-3 text-xs hover:underline md:py-1.5 md:pl-2"
            :class="
              pinnedUrls.has(row.url) ? 'text-amber-600 dark:text-amber-500' : 'text-neutral-500'
            "
            :aria-pressed="pinnedUrls.has(row.url)"
            :data-testid="`link-pin-${i}`"
            @click="$emit('pin', row)"
          >
            ピン
          </button>
        </li>
      </ul>

      <!-- キーの案内は、キーのある広い画面にだけ出す -->
      <p class="mt-4 hidden text-xs text-neutral-500 md:block">
        j / k で選び、Enter で開き、p でピンする
      </p>
    </div>
  </div>
</template>
