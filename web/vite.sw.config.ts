import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Service Worker だけを別に組む。
 *
 * public/ に素の js を置く手もあるが、それだと型が付かず、先読みと共有している
 * キャッシュ名（lib/sw-policy.ts）も import できない。名前がずれると
 * 「先読みした画像がオフラインで出ない」という、誰も気付けない壊れ方をする。
 *
 * 出力名は固定する。Service Worker は登録した URL がそのままスコープになるので、
 * ハッシュを付けると差し替えのたびに別物として登録されてしまう。
 * 形式は iife。ES モジュールの Service Worker は登録側で type: 'module' が要り、
 * 対応していないブラウザが残っている。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // 本体のビルドの後に走る。消すと dist/assets ごと消える
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      output: { entryFileNames: 'sw.js', format: 'iife' },
    },
  },
});
