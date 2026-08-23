import { computed, ref, watch, type Ref } from 'vue';
import { readPref, THEME_KEY, writePref } from '@/lib/prefs';

/**
 * 画面のテーマ（明 / 暗）。設計は docs/DESIGN.md §8。
 *
 * **システム設定を見るのは、まだ一度も選んでいない間だけ。** 一度でも切り替えたら
 * その選択が残り、以降 OS 側の切り替えには追随しない。「システムに従う」という
 * 選択肢は持たない（選び直せる 2 値だけにして、状態を増やさない）。
 *
 * 幅の判定（lib/viewport.ts）と同じく、アプリの生存期間そのままの状態なので
 * 購読の後始末は持たない。
 */

export type Theme = 'light' | 'dark';

/** 画面の地色（App.vue の bg-white / dark:bg-neutral-950）。アドレスバーの色に使う */
export const THEME_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#0a0a0a' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 選んだテーマ。null は「まだ選んでいない」 */
const choice = ref<Theme | null>(null);
const systemDark = ref(false);

/**
 * 実際に当てるテーマ。
 *
 * **index.html のインラインスクリプトが同じ規則を持っている**（初回描画より前に
 * 当てるため、import できない位置にある）。食い違いは lib/theme.test.ts が
 * 実際に走らせて突き合わせる。
 */
export function resolveTheme(chosen: Theme | null, dark: boolean): Theme {
  return chosen ?? (dark ? 'dark' : 'light');
}

const theme = computed(() => resolveTheme(choice.value, systemDark.value));

/**
 * `color-scheme` まで揃えるのは、**こちらで色を決められない部品**のため
 * （select のドロップダウン、スクロールバー、フォームの既定の見た目）。
 */
function apply(value: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = value;
  root.style.colorScheme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[value]);
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const saved = readPref(THEME_KEY);
  choice.value = saved === 'light' || saved === 'dark' ? saved : null;

  const query = window.matchMedia(DARK_QUERY);
  systemDark.value = query.matches;
  // 追随するのは、まだ選んでいない間だけ（選んだ後は theme が choice で決まる）
  query.addEventListener('change', (event) => {
    systemDark.value = event.matches;
  });

  // index.html が既に当てているが、当てる規則はこちらに寄せておく
  watch(theme, apply, { immediate: true });
}

/** 明暗を入れ替えて覚える。以降はシステム設定に追随しない */
export function toggleTheme(): void {
  choice.value = theme.value === 'dark' ? 'light' : 'dark';
  writePref(THEME_KEY, choice.value);
}

/** いま当たっているテーマ。書き換えは toggleTheme を通す */
export function useTheme(): Ref<Theme> {
  return theme;
}
