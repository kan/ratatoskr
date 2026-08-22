import { ref, type Ref } from 'vue';

/**
 * 画面の広さ（docs/UX.md「画面構成（スマホ）」）。
 *
 * 狭いときは記事ビューを既定にし、フィード一覧はヘッダから開く引き出しにする。
 * 境目は Tailwind の md（768px）に合わせてある。CSS 側の md: と食い違うと、
 * 左ペインが出ているのにボトムバーも出る、といった中途半端な形になる。
 *
 * **幅の変化に追随させる。** 端末を横に倒しただけで作りが変わるので、
 * 起動時に 1 回見るだけでは足りない。
 */
const COMPACT_QUERY = '(max-width: 767px)';

const compact = ref(false);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia(COMPACT_QUERY);
  compact.value = query.matches;
  query.addEventListener('change', (event) => {
    compact.value = event.matches;
  });
}

/** 狭い画面か。アプリの生存期間そのままなので、購読の後始末は要らない */
export function useCompact(): Ref<boolean> {
  return compact;
}
