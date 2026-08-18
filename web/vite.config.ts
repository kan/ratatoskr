import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 全インタフェースで待つ。WSL2 の既定（NAT）では、Windows のブラウザが解決する
    // localhost (::1) と、vite の既定の待ち受け先 (127.0.0.1) が食い違って繋がらない。
    // 0.0.0.0 なら localhost 転送でも WSL の IP 直打ちでも届く
    host: true,
    // 開発時は Vite(5173) で画面を、wrangler dev(8787) で API を動かす。
    // 本番は同一オリジンなので、クライアントは常に相対パスで /api を叩けばよい
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
