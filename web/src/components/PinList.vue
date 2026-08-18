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

defineEmits<{ close: []; remove: [pin: Pin] }>();

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
      <div class="flex items-baseline justify-between">
        <h2 class="text-base font-bold">ピン（{{ pins.count }}）</h2>
        <p class="text-xs text-neutral-500">o で全て開く / Esc・z で閉じる</p>
      </div>

      <p v-if="pins.count === 0" class="mt-4 text-xs text-neutral-500" data-testid="pin-empty">
        ピンした記事はまだない。読んでいる最中に p を押すと、ここに溜まる
      </p>

      <ul v-else class="mt-3">
        <li
          v-for="pin in pins.pins"
          :key="pin.url"
          class="flex items-baseline gap-3 border-t border-neutral-200 py-1.5 dark:border-neutral-800"
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
            class="shrink-0 text-xs text-neutral-500 hover:underline"
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
