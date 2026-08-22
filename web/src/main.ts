import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';

createApp(App).use(createPinia()).mount('#app');

/**
 * Service Worker の登録（docs/DESIGN.md §8）。
 *
 * **組み上げた資産にだけ効かせる。** 開発中は Vite がモジュールを都度配っていて、
 * 間にキャッシュを挟むと何が古いのか分からなくなる。オフライン動作を手元で
 * 確かめるときは `pnpm build && pnpm -C web preview` を使う。
 *
 * 描画の後に登録する。起動の速さは最優先なので、登録の往復を初回描画の前に置かない。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // 失敗しても読む分には困らない（オフラインで起動できなくなるだけ）
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.error('Service Worker の登録に失敗', err);
    });
  });
}
