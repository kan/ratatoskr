<script setup lang="ts">
import type { Pin } from '@shared/types';
import { usePinsStore } from '@/stores/pins';

/**
 * ピン一覧（z）。「後で処理する」ものを並べるだけの場所で、読む操作とは独立している。
 *
 * 開くのも閉じるのもキー 1 つで済ませたいので、オーバーレイにして画面遷移を作らない
 * （docs/UX.md）。
 */
const pins = usePinsStore();

defineEmits<{ close: []; openAll: []; remove: [pin: Pin] }>();

/** ピンした時刻。日付だけで足りる（後で処理するための目印） */
function pinnedOn(pin: Pin): string {
  return new Date(pin.pinnedAt * 1000).toLocaleDateString('ja-JP');
}
</script>

<template>
  <div
    class="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
    data-testid="pin-list"
    @click.self="$emit('close')"
  >
    <div class="w-full max-w-2xl rounded bg-white p-5 text-sm shadow-lg dark:bg-neutral-900">
      <!--
        操作はボタンで出す（issue #12）。**スマホには o も Esc も無い。**
        キーの案内だけだと、狭い画面では開いた後に何もできない一覧になる
        （背景を押せば閉じられるが、押して初めて分かる操作は道とは言えない）。
        括弧の中にキーを残すのは、PC 側で覚える手掛かりを消さないため（購読管理と同じ）
      -->
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-base font-bold">ピン（{{ pins.count }}）</h2>
        <span class="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
          <button
            v-if="pins.count > 0"
            type="button"
            class="hover:underline"
            data-testid="pin-open-all"
            @click="$emit('openAll')"
          >
            全て開く（o）
          </button>
          <button
            type="button"
            class="hover:underline"
            data-testid="pin-close"
            @click="$emit('close')"
          >
            閉じる（Esc）
          </button>
        </span>
      </div>

      <p v-if="pins.count === 0" class="mt-4 text-xs text-neutral-500" data-testid="pin-empty">
        ピンした記事はまだない。読んでいる最中に p を押すと、ここに溜まる
      </p>

      <!--
        **行は狭い画面で厚くする（issue #12）。** マウスの数ピクセルと違って、指は
        隣の行の「外す」を巻き込む。厚さを変えるだけで、並びも文言も PC と同じにする
      -->
      <ul v-else class="mt-3">
        <li
          v-for="pin in pins.pins"
          :key="pin.url"
          class="flex items-baseline gap-3 border-t border-neutral-200 py-3 md:py-1.5 dark:border-neutral-800"
          :data-testid="`pin-${pin.entryId ?? 'x'}`"
        >
          <span class="shrink-0 text-xs text-neutral-500 tabular-nums">{{ pinnedOn(pin) }}</span>
          <a
            :href="pin.url"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-1 truncate hover:underline"
          >
            {{ pin.title || pin.url }}
          </a>
          <button
            type="button"
            class="shrink-0 py-2.5 pl-3 text-xs text-neutral-500 hover:underline md:py-1.5 md:pl-2"
            :data-testid="`pin-remove-${pin.entryId ?? 'x'}`"
            @click="$emit('remove', pin)"
          >
            外す
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
