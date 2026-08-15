<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { HealthResponse } from '@shared/types';

// M0 の足場確認用。M3 で FeedList / EntryReader に置き換える
const health = ref<HealthResponse | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    health.value = (await res.json()) as HealthResponse;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <main class="p-6 font-mono text-sm">
    <h1 class="text-lg font-bold">Ratatoskr</h1>
    <p v-if="error" class="mt-2 text-red-600">API に到達できない: {{ error }}</p>
    <pre v-else-if="health" class="mt-2">{{ health }}</pre>
    <p v-else class="mt-2">…</p>
  </main>
</template>
