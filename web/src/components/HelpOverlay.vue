<script setup lang="ts">
import { computed } from 'vue';
import { GROUP_LABELS, KEYMAP, type KeyBinding } from '@/lib/keymap';

/**
 * ヘルプ。keymap.ts の定義から自動生成する（docs/UX.md）。
 * ここに一覧を書き写さないこと。書き写すと必ずキーの実体とずれる。
 */
const groups = computed(() => {
  const order: KeyBinding['group'][] = ['move', 'read', 'feed', 'other'];
  return order
    .map((group) => ({
      label: GROUP_LABELS[group],
      // レートの 1–5 は同じ操作なので 1 行にまとめる。5 行並べても読みにくいだけ
      bindings: collapseArguments(KEYMAP.filter((binding) => binding.group === group)),
    }))
    .filter((group) => group.bindings.length > 0);
});

/**
 * 同じ Action を引数違いで持つキー（レートの 1–5）を 1 行に畳む。
 * 表示だけの都合なので keymap.ts 側は分けたままにする（判定は 1 対 1 で行いたい）。
 *
 * 範囲は argument（数値）から作る。畳んだ後のラベルを読み返して作ると、
 * 表示の書式を変えただけで壊れる。
 */
function collapseArguments(bindings: readonly KeyBinding[]): KeyBinding[] {
  const collapsed: KeyBinding[] = [];
  const rows = new Map<KeyBinding['action'], { row: KeyBinding; first: number }>();

  for (const binding of bindings) {
    if (binding.argument === undefined) {
      collapsed.push(binding);
      continue;
    }

    const found = rows.get(binding.action);
    if (found === undefined) {
      const row = { ...binding, description: descriptionOf(binding.action) };
      rows.set(binding.action, { row, first: binding.argument });
      collapsed.push(row);
      continue;
    }
    found.row.label = `${found.first}–${binding.argument}`;
  }
  return collapsed;
}

function descriptionOf(action: KeyBinding['action']): string {
  return action === 'setRate' ? 'このフィードのレートを変える（読む順が変わる）' : '';
}

defineEmits<{ close: [] }>();
</script>

<template>
  <div
    class="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4"
    data-testid="help-overlay"
    @click.self="$emit('close')"
  >
    <div
      class="max-h-full w-full max-w-lg overflow-y-auto rounded bg-white p-5 text-sm shadow-lg dark:bg-neutral-900"
    >
      <h2 class="text-base font-bold">キーバインド</h2>
      <template v-for="group in groups" :key="group.label">
        <h3 class="mt-4 text-xs font-bold text-neutral-500">{{ group.label }}</h3>
        <dl class="mt-1">
          <div v-for="binding in group.bindings" :key="binding.label" class="flex gap-3 py-0.5">
            <dt class="w-28 shrink-0">
              <kbd
                class="rounded border border-neutral-400 px-1 font-mono text-xs dark:border-neutral-600"
              >
                {{ binding.label }}
              </kbd>
            </dt>
            <dd class="text-neutral-700 dark:text-neutral-300">{{ binding.description }}</dd>
          </div>
        </dl>
      </template>
      <p class="mt-5 text-xs text-neutral-500">Esc または ? で閉じる</p>
    </div>
  </div>
</template>
