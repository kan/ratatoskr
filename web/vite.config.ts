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
    // vite は *.localhost を自分で通すが、roji のドメインはそれ以外のこともある
    allowedHosts: process.env.ROJI_HOST ? [process.env.ROJI_HOST] : undefined,
    // 開発時は vite で画面を、wrangler dev で API を動かす。API のポートは
    // scripts/dev.mjs が空きから選んで渡す。**渡されなければ転送しない**
    // （vite を単体で起動したとき。E2E は API をモックする）。8787 を当て推量すると、
    // 他のプロジェクトの wrangler dev へ黙って繋がる。
    // 本番は同一オリジンなので、クライアントは常に相対パスで /api を叩けばよい
    proxy: process.env.RATATOSKR_API_PORT
      ? {
          '/api': {
            target: `http://127.0.0.1:${process.env.RATATOSKR_API_PORT}`,
            // **ホスト名を転送先に書き換える。** Access の検証を飛ばす開発用の
            // バイパスは localhost 宛の要求にしか効かない（src/lib/auth.ts）。
            // roji の URL（ratatoskr.<ドメイン>）のまま渡すと /api が全て 401 になる
            changeOrigin: true,
          },
        }
      : undefined,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
