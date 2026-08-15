# ROADMAP.md — 実装順

各マイルストーンは**それ単体で動作確認できる**ように区切ってある。M3 まで到達すれば「速い」を体感でき、以降は自分で使いながら育てられる。

先のマイルストーンの機能を前倒しで実装しないこと。

---

## M0: 足場

**完了条件: `pnpm dev` でローカルの Worker が起動し、`/api/health` が 200 を返す**

- [x] pnpm ワークスペース、TypeScript、ESLint、Prettier の設定
- [x] `wrangler.jsonc`（Workers + Static Assets + D1 + Cron の宣言）
- [x] Vue 3 + Vite + Tailwind v4 の最小構成
- [x] Vitest + `@cloudflare/vitest-pool-workers`
- [x] `shared/types.ts` の骨格
- [x] `GET /api/health`

---

## M1: クローラ

**完了条件: `wrangler dev` から cron を手動発火させ、D1 に記事が溜まることを確認できる**

- [x] `migrations/0001_init.sql` の適用
- [x] `src/db/` にクエリ層（SQL はここに閉じ込める）
- [x] フィード取得（条件付き GET、304 処理、content_hash によるスキップ）
- [x] `fast-xml-parser` による RSS 2.0 / Atom / RDF のパース
- [x] `guid_hash` の生成と `INSERT OR IGNORE`
- [x] `HTMLRewriter` によるサニタイズ
- [x] 取得間隔の適応制御と失敗バックオフ
- [x] Cron ハンドラ（`LIMIT 20`、並列度 4）
- [x] **パースのユニットテスト**（3 系統 + 日付の異常系のフィクスチャ）

この時点では UI も API も無い。`pnpm db:console` で中身を確認する。

---

## M2: 読み取り API

**完了条件: `curl` で `/api/bootstrap` を叩き、記事が返ってくる**

- [x] Cloudflare Access の JWT 検証（ローカルはバイパス可、本番でバイパスが効かないテスト）
- [x] `GET /api/bootstrap`
- [x] `GET /api/entries`（`sinceId` ページング）
- [x] `GET /api/sync`
- [x] エラーレスポンスの統一

---

## M3: PC UI — ここで一度「速い」を確認する

**完了条件: キーボードだけで全購読を消化でき、記事送りに一切の待ちが無い**

- [x] `lib/db.ts`（IndexedDB スキーマと入出力）
- [x] `lib/api.ts`（型付きクライアント）
- [x] `stores/feeds.ts` — **カーソルの単独所有者**
- [x] `stores/entries.ts`
- [x] `stores/session.ts`（起動シーケンスの手順）
- [x] `lib/keymap.ts` — キーバインドの一元定義
- [x] `FeedList.vue` / `EntryReader.vue` / `HelpOverlay.vue`
- [x] 起動シーケンス（IndexedDB から即描画 → bootstrap → 背景で全件取得）
- [x] Space の境界挙動（`docs/UX.md` の仕様通りに）
- [x] ヘルプの自動生成
- [x] 左ペインの記事一覧（読んでいるフィードのみ。既読は暗く表示）
- [x] `Shift+S`（フィードを全て既読にして次へ）
- [x] **既読ウォーターマークのユニットテスト**（web 側の vitest プロジェクトを追加）
- [x] **キーバインドの E2E テスト**

**ここが最初の山場。** この時点で既読はまだサーバに反映されない（ローカルのみ）。

実装しながら決めたこと:

- 既読は**記事を表示した時点**でその記事まで進める。フィードの最終記事に到達した時ではない
  （`docs/UX.md`「既読化のタイミング」）。読み進めた分が残り、左ペインの未読数もその場で減る
- `s` / `a` の移動対象は未読のあるフィードのみ。ただし戻る方向は既読のフィードにも入れる
- 全て読み終えたら先頭に戻らず「全て読み終えた」で止まる

---

## M4: 既読同期

**完了条件: 2 つのブラウザで開き、片方で読んだフィードがもう片方の再読み込み後に既読になっている**

- [ ] `POST /api/read`（`MAX` による更新、`batch()` 実行）
- [ ] `stores/outbox.ts`（IndexedDB 永続化、指数バックオフ、`keepalive` / `sendBeacon`）
- [ ] 表示した記事までの既読化発行（送信済みフラグは発行前に立てる）
- [x] `GET /api/sync` のクライアント側マージ（`Math.max` で受ける）
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
