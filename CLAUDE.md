# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業するための指示書です。

## プロジェクト概要

**Ratatoskr** は個人用のセルフホスト型 RSS リーダーです。Cloudflare Workers 上で動作し、PC とスマートフォンの両方から利用します。

設計上の目標はただ一つ、**livedoor Reader / Fastladder の「流れるように読める」操作感を Web で再現すること**です。機能の豊富さや見た目の派手さではなく、**キーを押してから次の記事が出るまでの遅延がゼロであること**を最優先します。この判断基準は全ての実装判断に優先します。

詳細な設計根拠は `docs/DESIGN.md`、操作系の仕様は `docs/UX.md`、API 定義は `docs/API.md`、実装順は `docs/ROADMAP.md` を参照してください。**作業前に必ず該当するドキュメントを読んでください。**

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| ランタイム | Cloudflare Workers (Static Assets 同梱) |
| DB | Cloudflare D1 (SQLite) |
| 定期実行 | Cron Triggers |
| フロントエンド | Vue 3 (Composition API) + TypeScript |
| ビルド | Vite |
| 状態管理 | Pinia |
| スタイル | Tailwind CSS v4 |
| クライアント永続化 | IndexedDB (`idb`) |
| XML パース | `fast-xml-parser` |
| HTML サニタイズ | Workers 組み込みの `HTMLRewriter` |
| 認証 | Cloudflare Access (Zero Trust) |
| テスト | Vitest + `@cloudflare/vitest-pool-workers`、E2E は Playwright |
| パッケージマネージャ | pnpm |

## ディレクトリ構成

```
.
├── CLAUDE.md
├── docs/               # 設計ドキュメント(この下は人間が管理。勝手に書き換えない)
├── migrations/         # D1 マイグレーション。連番 + 説明的な名前
├── src/                # Worker 側
│   ├── index.ts        # エントリポイント。fetch と scheduled の両ハンドラ
│   ├── api/            # API ハンドラ。1 エンドポイント 1 ファイル
│   ├── crawler/        # フィード取得・パース・サニタイズ・保存
│   ├── db/             # D1 クエリ。SQL はここに閉じ込める
│   └── lib/            # 認証、エラー、共通型
├── web/                # Vue アプリ
│   ├── src/
│   │   ├── components/
│   │   ├── stores/     # Pinia
│   │   ├── lib/        # api クライアント、IndexedDB、keymap、prefetch
│   │   └── main.ts
│   └── index.html
├── shared/             # Worker と web で共有する型定義
└── wrangler.jsonc
```

## 開発コマンド

```bash
pnpm install

pnpm dev                # wrangler dev。Vite の HMR 込みでローカル起動
pnpm build              # web をビルドして Worker にバンドル
pnpm deploy             # 本番デプロイ

pnpm db:migrate         # ローカル D1 にマイグレーション適用
pnpm db:migrate:remote  # 本番 D1 に適用
pnpm db:console         # ローカル D1 に SQL を投げる

pnpm test               # Vitest (Worker + web のユニット)
pnpm test:e2e           # Playwright
pnpm typecheck          # vue-tsc + tsc --noEmit
pnpm lint               # ESLint + Prettier
```

`pnpm typecheck` と `pnpm test` は**コミット前に必ず通す**こと。

## 開発環境の注意点

M0 の実装で判明した、環境まわりの制約と手順。

### 初回セットアップ（クローン直後）

```bash
pnpm install       # esbuild / workerd の postinstall 許可は pnpm-workspace.yaml にコミット済み
pnpm db:migrate    # .wrangler/ は未コミット。クローン直後のローカル D1 は空
pnpm dev
```

Node は 24 系。pnpm が未導入の環境で `corepack enable pnpm` が EACCES で失敗する場合は
`npm i -g pnpm` で入れてよい。

### 依存バージョンの制約

- **TypeScript は 5.9 に固定している。** vue-tsc 3.3.10 が TS 7 に未対応で、上げると
  `pnpm typecheck` が `ERR_PACKAGE_PATH_NOT_EXPORTED` で落ちる。vue-tsc の対応後に上げる
- `@cloudflare/vitest-pool-workers` 0.21 は `defineWorkersConfig` ではなく
  `cloudflareTest` プラグイン方式。`env` は `cloudflare:test` ではなく
  `cloudflare:workers` から import する
- テストから Worker の `fetch` を直接呼ぶときは `Request` ではなく `IncomingRequest`
  別名が必要（`src/api/health.test.ts` のパターンに従う）

### ローカル実行の細かい点

- `pnpm dev` は **vite(5173) と wrangler dev(8787) の 2 プロセス構成**。画面は 5173 を開き、
  `/api` は vite の proxy で 8787 に渡る。本番は同一オリジンなので、クライアントは常に
  相対パスで `/api` を叩けばよい
- `pnpm db:console` は SQL を引数で渡す: `pnpm db:console "SELECT * FROM feeds"`
- cron のローカル発火: `curl "http://localhost:8787/cdn-cgi/local/scheduled"`
- `pnpm test:e2e` は Playwright を入れる M3 まで存在しない
- `wrangler.jsonc` の `database_id` と `ACCESS_*` は `REPLACE_ME` のまま。ローカル開発には
  影響しないが、デプロイ前に設定する

## 絶対に守るアーキテクチャ上の不変条件

以下は設計の根幹であり、破ると同期やパフォーマンスが静かに壊れます。変更したくなった場合は実装せず、まず人間に相談してください。

### 1. 既読はウォーターマーク方式である

- `feeds.read_seq` に「既読済みの最大 `entries.id`」を持つ。記事ごとの既読フラグは**作らない**
- 未読判定は `entries.id > feeds.read_seq`
- 既読化は `UPDATE feeds SET read_seq = MAX(read_seq, ?)` で行う。**必ず `MAX` を使う**。単調増加であることが複数端末同期の唯一の保証なので、`SET read_seq = ?` と書いた瞬間に巻き戻りが発生する
- 順序は `entries.id`（クロール時に採番される AUTOINCREMENT）で決まる。`published_at` は**順序に使わない**。後から古い日付の記事が流れてきても未読として残す必要があるため

### 2. カーソルはフィードリストが所有する

- 「いまどのフィードのどの記事を読んでいるか」の状態は `stores/feeds.ts` が単独で持つ
- リーダーコンポーネントは表示するだけで、自分でカーソルを動かさない。移動要求はイベントとして上に投げる
- 先読みのスケジューリングもカーソル所有者が行う。読む順序と先読み順序が一致していることが先読みが当たる前提条件

### 3. 書き込みは必ず outbox を経由する

- 既読・ピン・レート変更は、まずローカル（IndexedDB + Pinia）に即時反映し、送信キューに積む
- UI はサーバのレスポンスを**待たない**
- 送信は冪等でなければならない。重複送信・順序逆転が起きても結果が変わらないこと
- 送信済みフラグはリクエスト発行**前**に立てる（後に立てると、離脱→復帰で二重送信が起きる。LDRoid が実際に踏んだバグ）

### 4. サニタイズは取り込み時にサーバ側で行う

- `entries.body` には**サニタイズ済みの HTML のみ**を保存する
- 生のフィード HTML をそのまま DB に入れない
- クライアント側で `v-html` する前提なので、DB の中身が信頼できることが安全性の全て

## Workers 環境の制約

Claude Code が間違えやすい点です。

- **`DOMParser` は存在しない。** フィードのパースは `fast-xml-parser` を使うこと
- **Node.js の API は基本的に使えない。** `fs`、`path`、`Buffer` などを import しない（`nodejs_compat` フラグに依存する実装は避ける）
- **`HTMLRewriter` は HTML 専用。** RSS/Atom のパースには使わない。用途はサニタイズのみ
- **1 リクエストあたりのサブリクエスト数に上限がある。** クローラは 1 回の cron 実行で処理するフィード数を必ず上限付きで絞る（`docs/DESIGN.md` 参照）
- **`fetch` の待ち時間は CPU 時間に計上されない。** I/O 待ちが多いこと自体は問題にならない
- **D1 には長時間トランザクションがない。** 複数ステートメントは `batch()` にまとめる

## フロントエンドの制約

- **キーバインドは `web/src/lib/keymap.ts` に一元定義する。** 個別のコンポーネントに `keydown` ハンドラを散らさない。ヘルプ画面（`?`）はこの定義から自動生成する
- **記事本文の描画で仮想スクロールを入れない。** 1 記事ずつ表示する設計なので不要。複雑さだけが増える
- **アニメーションは入れない。** 記事送りにトランジションを付けると、それがそのまま体感遅延になる。`docs/UX.md` の意図に反する
- **画像は遅延読み込みしない。** 先読みウィンドウで事前に Cache API に温めておくのが方針（`docs/DESIGN.md` の先読み節）

## コーディング規約

- TypeScript は `strict: true`。`any` は使わない。外部データは型ガードで検証してから使う
- Worker と web で共有する型は `shared/` に置き、両方から import する
- SQL は `src/db/` の外に書かない。API ハンドラから直接 D1 を叩かない
- エラーは握りつぶさない。クローラの取得失敗は `feeds.last_error` に記録して次回に活かす
- 日付・時刻は全て **Unix 秒（整数）** で扱う。ミリ秒と混在させない
- コメントは「なぜそうしたか」を書く。「何をしているか」はコードから読めるので不要

## テスト方針

- **クローラのパース処理は必ずテストを書く。** 実際のフィード XML をフィクスチャとして `src/crawler/__fixtures__/` に置く。RSS 2.0 / Atom / RDF の 3 系統と、日付形式の異常系を最低限カバーする
- **既読ウォーターマークのロジックは必ずテストを書く。** 特に「巻き戻らないこと」「新着が既読にならないこと」
- UI のテストは E2E に寄せる。キーバインドが期待通りに動くことを Playwright で確認する
- カバレッジ目標は設けない。壊れたときに気付けるかどうかで判断する

## コミット

- コミットメッセージは日本語で、何をなぜ変えたかを書く
- 1 コミット 1 論点。マイグレーションと機能実装は分ける
- `docs/` 配下の変更は独立したコミットにする

## 作業の進め方

- `docs/ROADMAP.md` のマイルストーン順に進める。先の機能を勝手に実装しない
- 設計ドキュメントと実装が食い違う場合、**ドキュメントを正とする**。実装を変えるか、人間に相談すること
- 判断に迷う設計上の選択肢が出てきたら、勝手に決めずに選択肢とトレードオフを提示する
