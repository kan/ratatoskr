<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Feed, FeedErrorKind } from '@shared/types';
import { sortByReadingOrder, useFeedsStore } from '@/stores/feeds';
import { useSessionStore } from '@/stores/session';

/**
 * 購読管理。**ここだけは普通のフォーム UI でよい**（docs/ROADMAP.md M5）。
 *
 * 読む操作と違って頻度が低く、サーバの応答（フィードの検出結果、初回クロールで
 * 取れた記事）をその場で見せる必要がある。待たせないための作り込みはしない。
 */
const feeds = useFeedsStore();
const session = useSessionStore();

const emit = defineEmits<{ close: [] }>();

/** レートは 1–5（docs/UX.md）。高い方が先に読まれるので降順で並べる */
const RATE_OPTIONS = [5, 4, 3, 2, 1];

/**
 * 一括解除の対象にする失敗と、消してよいと判断するまでの連続失敗回数。
 *
 * 何度試しても結果が変わらないもの（404 は何度引いても 404）は 1 回で足りる。
 * 接続できない・応答が無いは、相手の一時的な不調やこちらの回線でも起きるので、
 * 2 回続けて失敗するまで待つ。**解除は取り消せず記事ごと消える**ので、
 * 迷う側は残す方に倒す。
 *
 * 接続断（connection_lost）と 5xx は、続いていても相手の障害であることが多いので
 * 対象にしない。
 */
const REMOVABLE: Record<string, { label: string; minFailures: number }> = {
  not_found: { label: '見つからない（404 / 410）', minFailures: 1 },
  forbidden: { label: '拒否される（401 / 403）', minFailures: 1 },
  not_a_feed: { label: 'フィードではない', minFailures: 1 },
  unreachable: { label: '接続できない（ドメイン消滅）', minFailures: 2 },
  timeout: { label: '応答が無い（打ち切り）', minFailures: 2 },
};

function isRemovable(feed: Feed): boolean {
  if (feed.lastErrorKind === null) return false;
  const rule = REMOVABLE[feed.lastErrorKind];
  return rule !== undefined && feed.consecutiveFailures >= rule.minFailures;
}

/** 失敗の分類を日本語にする。分類が無い（成功している）場合は空 */
function reasonLabel(kind: FeedErrorKind | null): string {
  if (kind === null) return '';
  return REMOVABLE[kind]?.label ?? kind;
}

const url = ref('');
const rate = ref(3);
const folder = ref('');
const busy = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);
/** フィードが複数見つかったときの選択肢。選ぶまで登録しない */
const candidates = ref<{ url: string; title: string | null }[]>([]);

// 並びは左ペインと同じ読む順序にする。ここだけ別の規則で並べると、
// 「上にあるものから読まれる」という前提が画面ごとに食い違う
const sorted = computed(() => sortByReadingOrder(feeds.feeds));

/** 取りに行っても直らない失敗をしているフィード。一括解除の対象そのもの */
const removable = computed(() => sorted.value.filter(isRemovable));

/**
 * 一覧を「問題のあるフィードだけ」に絞る。消す前に中身を見せるための表示。
 * 対象が無くなったら自動で戻す（絞り込みを解除する導線ごと消えて詰むため）。
 */
const problemsOnly = ref(false);
const rows = computed(() =>
  problemsOnly.value && removable.value.length > 0 ? removable.value : sorted.value,
);

async function removeUnreachable(): Promise<void> {
  const targets = removable.value;
  const summary = Object.entries(
    targets.reduce<Record<string, number>>((count, feed) => {
      const label = reasonLabel(feed.lastErrorKind);
      count[label] = (count[label] ?? 0) + 1;
      return count;
    }, {}),
  )
    .map(([label, count]) => `  ${label}: ${count} 件`)
    .join('\n');

  // 記事ごと消える。取り消せないので、理由の内訳を見せてから確認する
  if (!window.confirm(`${targets.length} 件の購読を解除する。記事も消える\n\n${summary}`)) return;

  await run(async () => {
    const removed = await session.unsubscribeMany(targets.map((feed) => feed.id));
    message.value =
      removed.length === targets.length
        ? `${removed.length} 件の購読を解除した`
        : `${removed.length} 件を解除した（${targets.length - removed.length} 件は失敗）`;
    if (removable.value.length === 0) problemsOnly.value = false;
  });
}

function report(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = null;
  message.value = null;
  try {
    await action();
  } catch (err) {
    report(err);
  } finally {
    busy.value = false;
  }
}

function add(feedUrl: string): Promise<void> {
  return run(async () => {
    const result = await session.subscribe({
      url: feedUrl,
      rate: rate.value,
      folder: folder.value.trim(),
    });
    if (result.kind === 'candidates') {
      candidates.value = result.candidates;
      message.value = 'フィードが複数見つかった。どれを購読するか選ぶ';
      return;
    }
    candidates.value = [];
    url.value = '';
    message.value = '購読を追加した';
  });
}

function remove(feed: Feed): Promise<void> | undefined {
  // 記事ごと消える操作なので確認する。取り消せない
  if (!window.confirm(`「${feed.title || feed.url}」の購読を解除する。記事も消える`)) return;
  return run(async () => {
    await session.unsubscribe(feed.id);
    message.value = '購読を解除した';
  });
}

function changeRate(feed: Feed, value: string): Promise<void> {
  return run(() => session.editFeed(feed.id, { rate: Number(value) }));
}

function changeFolder(feed: Feed, value: string): Promise<void> {
  return run(() => session.editFeed(feed.id, { folder: value.trim() }));
}

/**
 * 改名。失敗したら入力欄を元の値に戻す。
 * feed.title が変わっていない以上 Vue は再描画しないので、
 * 放っておくと保存できなかった文字列が残り続けて保存済みに見える。
 */
async function rename(feed: Feed, input: HTMLInputElement): Promise<void> {
  const title = input.value.trim();
  if (title === '' || title === feed.title) {
    input.value = feed.title;
    return;
  }
  await run(() => session.editFeed(feed.id, { title }));
  if (error.value !== null) input.value = feed.title;
}

function toggleDisabled(feed: Feed): Promise<void> {
  return run(() => session.editFeed(feed.id, { disabled: !feed.disabled }));
}

function refresh(feed: Feed): Promise<void> {
  return run(async () => {
    const added = await session.refresh(feed.id);
    message.value = added === 0 ? '新着は無かった' : `${added} 件の新着を取得した`;
  });
}

async function onOpmlSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;

  await run(async () => {
    const result = await session.restoreFromOpml(file);
    const failed =
      result.failed.length === 0 ? '' : `、${result.failed.length} 件は取り込めなかった`;
    message.value = `${result.imported} 件を取り込んだ（${result.skipped} 件は購読済み）${failed}`;
  });
  // 同じファイルをもう一度選べるようにする
  input.value = '';
}
</script>

<template>
  <div
    class="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
    data-testid="subscription-manager"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-3xl rounded bg-white p-5 text-sm shadow-lg dark:bg-neutral-900">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-bold">購読管理</h2>
        <button class="text-xs text-neutral-500 hover:underline" @click="emit('close')">
          閉じる（Esc）
        </button>
      </div>

      <form class="mt-4 flex flex-wrap items-end gap-2" @submit.prevent="add(url)">
        <label class="flex flex-1 flex-col gap-1">
          <span class="text-xs text-neutral-500">サイト URL / フィード URL</span>
          <input
            v-model="url"
            type="text"
            required
            placeholder="https://example.com/"
            data-testid="feed-url"
            class="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-neutral-500">レート</span>
          <select
            v-model.number="rate"
            class="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option v-for="value in [5, 4, 3, 2, 1]" :key="value" :value="value">
              {{ value }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-neutral-500">フォルダ</span>
          <input
            v-model="folder"
            type="text"
            placeholder="未分類"
            class="w-32 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>
        <button
          type="submit"
          :disabled="busy"
          data-testid="feed-add"
          class="rounded bg-neutral-800 px-3 py-1 text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
        >
          追加
        </button>
      </form>

      <p v-if="message" class="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
        {{ message }}
      </p>
      <p v-if="error" class="mt-2 text-xs text-red-700 dark:text-red-400" data-testid="feed-error">
        {{ error }}
      </p>

      <ul v-if="candidates.length > 0" class="mt-2 space-y-1" data-testid="feed-candidates">
        <li v-for="candidate in candidates" :key="candidate.url">
          <button class="text-left text-xs hover:underline" @click="add(candidate.url)">
            {{ candidate.title ?? candidate.url }}
            <span class="text-neutral-500">{{ candidate.url }}</span>
          </button>
        </li>
      </ul>

      <table class="mt-5 w-full table-fixed border-collapse text-xs">
        <thead class="text-left text-neutral-500">
          <tr>
            <th class="w-auto py-1">タイトル</th>
            <th class="w-16 py-1">レート</th>
            <th class="w-28 py-1">フォルダ</th>
            <th class="w-16 py-1 text-right">未読</th>
            <th class="w-40 py-1"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="feed in rows"
            :key="feed.id"
            class="border-t border-neutral-200 align-top dark:border-neutral-800"
            :data-testid="`manage-feed-${feed.id}`"
          >
            <td class="py-1 pr-2">
              <input
                :value="feed.title"
                class="w-full bg-transparent"
                :class="feed.disabled ? 'text-neutral-400 line-through' : ''"
                @change="rename(feed, $event.target as HTMLInputElement)"
              />
              <a
                :href="feed.siteUrl ?? feed.url"
                target="_blank"
                rel="noopener noreferrer"
                class="block truncate text-neutral-500 hover:underline"
              >
                {{ feed.url }}
              </a>
              <p v-if="feed.lastError" class="text-red-700 dark:text-red-400">
                {{ feed.lastError }}
                <span v-if="feed.consecutiveFailures > 1">
                  — {{ feed.consecutiveFailures }} 回連続
                </span>
                <span v-if="isRemovable(feed)">（{{ reasonLabel(feed.lastErrorKind) }}）</span>
              </p>
            </td>
            <td class="py-1 pr-2">
              <select
                :value="feed.rate"
                class="bg-transparent"
                @change="changeRate(feed, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="value in RATE_OPTIONS" :key="value" :value="value">
                  {{ value }}
                </option>
              </select>
            </td>
            <td class="py-1 pr-2">
              <input
                :value="feed.folder"
                class="w-full bg-transparent"
                @change="changeFolder(feed, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td class="py-1 pr-2 text-right tabular-nums">{{ feed.unreadCount }}</td>
            <td class="space-x-2 py-1 text-right">
              <button class="hover:underline" :disabled="busy" @click="refresh(feed)">更新</button>
              <button class="hover:underline" :disabled="busy" @click="toggleDisabled(feed)">
                {{ feed.disabled ? '再開' : '停止' }}
              </button>
              <button
                class="text-red-700 hover:underline dark:text-red-400"
                :disabled="busy"
                :data-testid="`manage-delete-${feed.id}`"
                @click="remove(feed)"
              >
                解除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="removable.length > 0"
        class="mt-3 flex flex-wrap items-center gap-3 rounded bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950"
        data-testid="unreachable-bar"
      >
        <span>取得できないフィードが {{ removable.length }} 件ある</span>
        <button
          class="hover:underline"
          data-testid="toggle-problems"
          @click="problemsOnly = !problemsOnly"
        >
          {{ problemsOnly ? '全て表示' : '問題のあるフィードだけ表示' }}
        </button>
        <button
          class="text-red-700 hover:underline dark:text-red-400"
          :disabled="busy"
          data-testid="remove-unreachable"
          @click="removeUnreachable"
        >
          {{ removable.length }} 件をまとめて解除
        </button>
      </div>

      <div
        class="mt-5 flex items-center gap-4 border-t border-neutral-200 pt-3 dark:border-neutral-800"
      >
        <a href="/api/opml" download class="text-xs hover:underline">OPML を書き出す</a>
        <label class="text-xs hover:underline">
          OPML を取り込む
          <input
            type="file"
            accept=".opml,.xml,text/x-opml"
            class="hidden"
            @change="onOpmlSelected"
          />
        </label>
        <span class="text-xs text-neutral-500">取り込んだ購読は次回の定期取得で記事が入る</span>
      </div>
    </div>
  </div>
</template>
