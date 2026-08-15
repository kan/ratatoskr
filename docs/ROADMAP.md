# ROADMAP.md — 実装順

各マイルストーンは**それ単体で動作確認できる**ように区切ってある。M3 まで到達すれば「速い」を体感でき、以降は自分で使いながら育てられる。

先のマイルストーンの機能を前倒しで実装しないこと。

---

## M0: 足場

**完了条件: `pnpm dev` でローカルの Worker が起動し、`/api/health` が 200 を返す**

- [ ] pnpm ワークスペース、TypeScript、ESLint、Prettier の設定
- [ ] `wrangler.jsonc`（Workers + Static Assets + D1 + Cron の宣言）
- [ ] Vue 3 + Vite + Tailwind v4 の最小構成
- [ ] Vitest + `@cloudflare/vitest-pool-workers`
- [ ] `shared/types.ts` の骨格
- [ ] `GET /api/health`

---

## M1: クローラ

**完了条件: `wrangler dev` から cron を手動発火させ、D1 に記事が溜まることを確認できる**

- [ ] `migrations/0001_init.sql` の適用
- [ ] `src/db/` にクエリ層（SQL はここに閉じ込める）
- [ ] フィード取得（条件付き GET、304 処理、content_hash によるスキップ）
- [ ] `fast-xml-parser` による RSS 2.0 / Atom / RDF のパース
- [ ] `guid_hash` の生成と `INSERT OR IGNORE`
- [ ] `HTMLRewriter` によるサニタイズ
- [ ] 取得間隔の適応制御と失敗バックオフ
- [ ] Cron ハンドラ（`LIMIT 20`、並列度 4）
- [ ] **パースのユニットテスト**（3 系統 + 日付の異常系のフィクスチャ）

この時点では UI も API も無い。`pnpm db:console` で中身を確認する。

---

## M2: 読み取り API

**完了条件: `curl` で `/api/bootstrap` を叩き、記事が返ってくる**

- [ ] Cloudflare Access の JWT 検証（ローカルはバイパス可、本番でバイパスが効かないテスト）
- [ ] `GET /api/bootstrap`
- [ ] `GET /api/entries`（`sinceId` ページング）
- [ ] `GET /api/sync`
- [ ] エラーレスポンスの統一

---

## M3: PC UI — ここで一度「速い」を確認する

**完了条件: キーボードだけで全購読を消化でき、記事送りに一切の待ちが無い**

- [ ] `lib/db.ts`（IndexedDB スキーマと入出力）
- [ ] `lib/api.ts`（型付きクライアント）
- [ ] `stores/feeds.ts` — **カーソルの単独所有者**
- [ ] `stores/entries.ts`
- [ ] `lib/keymap.ts` — キーバインドの一元定義
- [ ] `FeedList.vue` / `EntryReader.vue` / `HelpOverlay.vue`
- [ ] 起動シーケンス（IndexedDB から即描画 → bootstrap → 背景で全件取得）
- [ ] Space の境界挙動（`docs/UX.md` の仕様通りに）
- [ ] ヘルプの自動生成
- [ ] **キーバインドの E2E テスト**

**ここが最初の山場。** この時点で既読はまだサーバに反映されない（ローカルのみ）。

---

## M4: 既読同期

**完了条件: 2 つのブラウザで開き、片方で読んだフィードがもう片方の再読み込み後に既読になっている**

- [ ] `POST /api/read`（`MAX` による更新、`batch()` 実行）
- [ ] `stores/outbox.ts`（IndexedDB 永続化、指数バックオフ、`keepalive` / `sendBeacon`）
- [ ] 最終記事表示時の既読化発行（送信済みフラグは発行前に立てる）
- [ ] `GET /api/sync` のクライアント側マージ（`Math.max` で受ける）
- [ ] `POST /api/entries/:id/unread` と `u` キー
- [ ] **ウォーターマークのユニットテスト**（巻き戻らないこと、新着が既読にならないこと、重複送信で壊れないこと）

---

## M5: 購読管理

**完了条件: UI からフィードを追加・削除でき、OPML で往復できる**

- [ ] `POST /api/feeds`（フィード自動検出、同期的な初回クロール、複数候補の提示）
- [ ] `PATCH /api/feeds/:id` / `DELETE /api/feeds/:id`
- [ ] `POST /api/feeds/:id/fetch` と `r` キー
- [ ] レート（`1`–`5` キー、左ペインの即時再ソート、先読みウィンドウの再計算）
- [ ] フォルダ
- [ ] `GET /api/opml` / `POST /api/opml`
- [ ] 購読管理画面（ここだけは普通のフォーム UI でよい）

---

## M6: ピン

**完了条件: `p` でピンし、`z` で一覧を開き、`o` で全てタブに開ける**

- [ ] `POST /api/pins` / `DELETE /api/pins/:id`
- [ ] `p` / `z` / `o` キー
- [ ] `PinList.vue`（オーバーレイ）
- [ ] 記事削除後もピンが残ることの確認

---

## M7: 画像の先読み

**完了条件: フィードを送った直後に画像が既に表示されている**

- [ ] `lib/prefetch.ts` — カーソル相対ウィンドウ（3 フィード先、並列度 4）
- [ ] in-flight リクエストの束ね（同一 URL の重複排除）
- [ ] ウィンドウ外の破棄
- [ ] Cache API への書き込み

M3 の時点で本文は全件手元にあるので、これは画像だけの最適化。効果を体感しやすいので後半に置いてある。

---

## M8: スマホ UI / PWA

**完了条件: スマホの標準ブラウザからホーム画面に追加し、機内モードで既読操作をして復帰後に同期される**

- [ ] レスポンシブ切り替え（記事ビューを既定表示に）
- [ ] ボトムバーと境界でのラベル変化
- [ ] 左右スワイプでの記事送り
- [ ] `env(safe-area-inset-bottom)` 対応
- [ ] Service Worker（アプリシェルのプリキャッシュ、SWR、画像の LRU）
- [ ] `manifest.json`、アイコン
- [ ] オフライン時の outbox 動作確認

---

## M9: 運用

- [ ] 保持期間による記事削除（cron 内で 1 日 1 回）
- [ ] `consecutive_failures` 超過フィードの UI 警告
- [ ] デプロイ手順の README 化
- [ ] D1 のバックアップ方針

---

## 将来検討（MVP に含めない）

- RSS 以外のソース（Mastodon、YouTube、Podcast）
- 要約フィードに対する全文取得
- 全文検索
- 未読記事のフィルタリング／ミュートワード
