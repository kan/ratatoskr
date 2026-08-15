# Ratatoskr

個人用のセルフホスト型 RSS リーダー。Cloudflare Workers + D1 の上で動き、PC とスマートフォンから同じ購読状態を共有する。

目標は一つだけで、**livedoor Reader / Fastladder の「流れるように読める」操作感を Web で再現すること**。キーを押してから次の記事が出るまでの遅延がゼロであることを、機能の豊富さや見た目より優先する。

名前は、北欧神話でユグドラシルを往き来してメッセージを運ぶリスに由来する。

## 現在の状態

M0（足場）まで完了。まだフィードは読めない。実装順は [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

## 設計の中核

- **既読はウォーターマーク方式**。記事ごとの既読フラグを持たず、フィードごとに「既読済みの最大 entry id」を 1 つ持つ。更新は常に `MAX` なので単調増加し、複数端末の衝突解決が `Math.max` だけで済む
- **起動時に記事本文を全件先落とし**する。想定規模（50〜150 フィード）なら手元に置けるので、記事送りがネットワークを待たない
- **書き込みは outbox 経由**。既読・ピン・レート変更はローカルに即時反映し、送信は非同期・冪等

詳細は [docs/DESIGN.md](docs/DESIGN.md)、操作系は [docs/UX.md](docs/UX.md)、API は [docs/API.md](docs/API.md) に書いてある。

## 技術スタック

Cloudflare Workers (Static Assets) / D1 / Cron Triggers / Vue 3 + TypeScript / Vite / Pinia / Tailwind CSS v4 / IndexedDB / Cloudflare Access

## 開発

```bash
pnpm install
pnpm db:migrate   # ローカル D1 にスキーマを適用
pnpm dev          # vite(5173) と wrangler dev(8787) を同時起動
```

画面は http://localhost:5173 を開く。`/api` は 8787 の Worker にプロキシされる（本番は同一オリジン）。

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバ |
| `pnpm build` | web をビルドして `web/dist` に出力 |
| `pnpm test` | Vitest（workerd 上で実行） |
| `pnpm typecheck` | `tsc` + `vue-tsc` |
| `pnpm lint` | ESLint + Prettier |
| `pnpm db:console "SQL"` | ローカル D1 に SQL を投げる |

## デプロイ

未整備（M9 で手順化する）。最低限、`wrangler d1 create` で作った `database_id` と Cloudflare Access の `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を `wrangler.jsonc` に設定する必要がある。
