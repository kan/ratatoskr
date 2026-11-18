<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EntryAudio, TranscriptResponse } from '@shared/types';
import { formatTime } from '@shared/time';
import { getTranscript } from '@/lib/api';
import { releaseKeyFocus } from '@/lib/keymap';

/**
 * Podcast のエピソードの再生器・要約・文字起こし（issue #46）。記事の本文の上に出す。
 *
 * 親は記事ごとに作り直す（`:key`）。記事を移れば再生は止まり、開いた文字起こしも閉じる。
 * 記事をまたいで鳴らし続ける常駐の再生器にはしない（読む画面の主役は記事のまま）。
 *
 * **音声は先読みしない**（`preload="none"`）。画像と違って 1 本 100MB を超え、
 * 記事を送るたびに取りに行けば回線を使い潰す。再生を押してから取りに行く。
 *
 * 要約は値で届く（TranscriptSummary）。文字として描くだけで v-html は使わない
 * （中身は LLM の出力なので）。
 */
const props = defineProps<{ entryId: number; audio: EntryAudio }>();

const player = ref<HTMLAudioElement | null>(null);

/** 開いた文字起こし。開くまで取りに行かない */
const transcript = ref<TranscriptResponse | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

/**
 * 清書前（Whisper の区間）を出すか。既定は清書した段落。清書前は、LLM が意味を変えて
 * いないかを確かめるためのもの
 */
const showRaw = ref(false);

/** 清書した段落を出すか。清書し終えていて、清書前を選んでいなければ */
const showParagraphs = computed(() => transcript.value?.paragraphs != null && !showRaw.value);

/** 文字起こしに出す行。段落か、清書前の区間 */
const lines = computed(() =>
  showParagraphs.value ? (transcript.value?.paragraphs ?? []) : (transcript.value?.segments ?? []),
);

function toggleRaw(event: Event): void {
  releaseKeyFocus(event);
  showRaw.value = !showRaw.value;
}

/**
 * 要約。記事に添えて届いたものが無ければ、文字起こしを開いたときに届いたものを使う
 * （読み流した後に要約ができた記事は、差分同期で届け直されない）
 */
const summary = computed(() => props.audio.summary ?? transcript.value?.summary ?? null);

/** 目次。要約があれば区間ごとの要約、まだ無ければチャプターだけ */
const contents = computed(() =>
  summary.value !== null
    ? summary.value.sections
    : props.audio.chapters.map((chapter) => ({ ...chapter, text: '' })),
);

const stateLabel = computed(() => {
  if (summary.value !== null) return null;
  if (props.audio.transcript === 'running') return '文字起こし中';
  if (props.audio.transcript === 'failed') return '文字起こしできなかった';
  return null;
});

/** 押した位置から鳴らす。押した後もフォーカスを残すと、次の Space がボタンの再発火になる */
function seek(event: Event, seconds: number): void {
  releaseKeyFocus(event);
  const el = player.value;
  if (el === null) return;
  el.currentTime = seconds;
  void el.play().catch(() => {
    // 自動再生の制限に当たっても、位置は合っているので押せば続きから鳴る
  });
}

async function toggleTranscript(event: Event): Promise<void> {
  releaseKeyFocus(event);
  if (transcript.value !== null) {
    transcript.value = null;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    transcript.value = await getTranscript(props.entryId);
  } catch {
    loadError.value = '文字起こしを取れなかった（オフラインでは開けない）';
  } finally {
    loading.value = false;
  }
}

const TIME_BUTTON = 'shrink-0 font-mono text-xs text-sky-700 hover:underline dark:text-sky-400';
const TOGGLE_BUTTON =
  'rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:hover:text-neutral-100';
</script>

<template>
  <section class="mb-5 space-y-3" data-testid="podcast">
    <audio
      ref="player"
      class="w-full"
      controls
      preload="none"
      :src="audio.url"
      data-testid="podcast-audio"
    ></audio>

    <p class="text-xs text-neutral-500">
      <span v-if="audio.duration !== null">{{ formatTime(audio.duration) }}</span>
      <span v-if="stateLabel !== null" data-testid="podcast-state">
        <template v-if="audio.duration !== null"> / </template>{{ stateLabel }}</span
      >
    </p>

    <div
      v-if="summary !== null || contents.length > 0"
      class="space-y-2 rounded border border-neutral-300 p-3 text-sm leading-relaxed dark:border-neutral-700"
      data-testid="podcast-summary"
    >
      <p v-if="summary !== null">{{ summary.overview }}</p>
      <ul class="space-y-1" data-testid="podcast-contents">
        <li v-for="item in contents" :key="item.start" class="flex gap-2">
          <button type="button" :class="TIME_BUTTON" @click="seek($event, item.start)">
            {{ formatTime(item.start) }}
          </button>
          <span>
            <strong v-if="item.title !== null">{{ item.title }}</strong>
            {{ item.text }}
          </span>
        </li>
      </ul>
    </div>

    <div v-if="audio.transcript !== undefined">
      <button
        type="button"
        :class="TOGGLE_BUTTON"
        :disabled="loading"
        data-testid="podcast-transcript-toggle"
        @click="toggleTranscript"
      >
        {{
          transcript === null
            ? loading
              ? '読み込み中…'
              : '文字起こしを開く'
            : '文字起こしを閉じる'
        }}
      </button>
      <button
        v-if="transcript !== null && transcript.paragraphs !== null"
        type="button"
        :class="['ml-2', TOGGLE_BUTTON]"
        data-testid="podcast-transcript-raw"
        @click="toggleRaw"
      >
        {{ showRaw ? '清書を表示' : '清書前を表示' }}
      </button>
      <p v-if="loadError !== null" class="mt-1 text-xs text-red-600">{{ loadError }}</p>
      <ol
        v-if="transcript !== null"
        :class="['mt-2 text-sm leading-relaxed', showParagraphs ? 'space-y-3' : 'space-y-1']"
        data-testid="podcast-transcript"
      >
        <li v-for="(segment, index) in lines" :key="index" class="flex gap-2">
          <button type="button" :class="TIME_BUTTON" @click="seek($event, segment.start)">
            {{ formatTime(segment.start) }}
          </button>
          <span>{{ segment.text }}</span>
        </li>
        <li v-if="transcript.state === 'running'" class="text-xs text-neutral-500">
          （文字起こし中。続きは後で届く）
        </li>
      </ol>
    </div>
  </section>
</template>
