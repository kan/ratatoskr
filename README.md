# Ratatoskr

個人用のセルフホスト型 RSS リーダー。Cloudflare Workers + D1 の上で動き、PC とスマートフォンから同じ購読状態を共有する。

目標は一つだけで、**livedoor Reader / Fastladder の「流れるように読める」操作感を Web で再現すること**。キーを押してから次の記事が出るまでの遅延がゼロであることを、機能の豊富さや見た目より優先する。

名前は、北欧神話でユグドラシルを往き来してメッセージを運ぶリスに由来する。

## 現在の状態

M9（運用）まで完了。購読の追加からスマホでの購読・オフライン読みまで一通り動く。
実装順と、各マイルストーンで決めたことは [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

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
cp .dev.vars.example .dev.vars   # Access の secret を埋める（検証を飛ばすのは pnpm dev の --var）
cp .env.example .env             # Workers AI の接続に要る（下記。デプロイ後だけ）
pnpm db:migrate                  # ローカル D1 にスキーマを適用
pnpm dev                         # vite(5173) と wrangler dev(8787) を同時起動
```

画面は http://localhost:5173 を開く。`/api` は 8787 の Worker にプロキシされる（本番は同一オリジン）。

### ローカル開発にも Access の資格情報が要る

**一度デプロイして Access を掛けた後は、`pnpm dev` にも Service Token が要る。**

```
✘ [ERROR] Failed to start the remote proxy session. Error reloading remote server:
  The domain "ratatoskr.<subdomain>.workers.dev" is behind Cloudflare Access, but no
  Access Service Token credentials were found and the current environment is non-interactive.
```

Workers AI（`env.AI`）はローカル実行されず必ずリモートに繋ぐが、その接続先が
**デプロイ済みの workers.dev ホスト名**で、そこに Access を掛けてあるため、
ローカルの wrangler が自分の Worker の入口で止められる。`wrangler login` は
関係ない（あれは Cloudflare API の認可。Access は HTTP の関門なので別経路）。

1. Zero Trust → **Access → Service Auth → Service Tokens → Create Service Token**。
   名前は `wrangler-dev` など。**Client Secret はこの一度しか表示されない**
2. `cp .env.example .env` して、出た値を `CLOUDFLARE_ACCESS_CLIENT_ID` と
   `CLOUDFLARE_ACCESS_CLIENT_SECRET` に入れる（`.env` は git 管理外。
   Worker に渡る変数ではないので `.dev.vars` とは別のファイル）
3. `ratatoskr` の Access アプリに、**Action = Service Auth**、
   Include = Service Token → `wrangler-dev` のポリシーを足す

**このトークンは本番の `/api/*` にも到達できる**（Worker 側は JWT の `aud` しか見ないので、
人間のログインと区別しない）。手元から出さないこと。

`cloudflared access login` でも通せるが、`pnpm dev` は concurrently 経由で
子プロセスの stdio が pipe になり、wrangler が「非対話」と判断してその経路に入らない。
Service Token なら対話・非対話を問わない。

| コマンド                | 内容                               |
| ----------------------- | ---------------------------------- |
| `pnpm dev`              | 開発サーバ                         |
| `pnpm build`            | web をビルドして `web/dist` に出力 |
| `pnpm test`             | Vitest（workerd 上で実行）         |
| `pnpm typecheck`        | `tsc` + `vue-tsc`                  |
| `pnpm lint`             | ESLint + Prettier                  |
| `pnpm db:console "SQL"` | ローカル D1 に SQL を投げる        |

## デプロイ

セルフホストなので、Cloudflare のアカウント 1 つに自分用の 1 台を立てる。所要は初回で 15 分ほど。

### 1. D1 を作る

```bash
pnpm exec wrangler d1 create ratatoskr
```

出力された id を、git 管理外の `.prod.vars` に置く。**アカウント固有の値はこのファイルにだけ書く。**

```bash
cat > .prod.vars <<'EOF'
D1_DATABASE_ID=<wrangler d1 create の出力の id>

# Access の値。この時点ではまだ分からないので空でよい（4 で入れる）
ACCESS_TEAM_DOMAIN=
ACCESS_AUD=
EOF
```

`pnpm deploy` は毎回ここから 2 つを組み立てる。`wrangler.jsonc` に `database_id` を差し込んだ
`wrangler.deploy.json` と、secret を渡す `.wrangler/deploy-secrets.env`（どちらも git 管理外）。

- `database_id` を設定ファイルに書かないのは、公開リポジトリに残さないため。デプロイ時に
  この値は必須で、データベース名だけでは解決されない
- secret を毎回渡すのは、**Worker を作り直したときに 1 コマンドで戻せるようにする**ため。
  `wrangler.jsonc` に secret 名を宣言してあると、デプロイは前の版から値を引き継ごうとする。
  Worker が消えていると引き継ぎ元が無く `no previous version exists` で止まる

### 2. スキーマを本番に適用する

```bash
pnpm db:migrate:remote
```

`migrations/` を順に当てる。以降、マイグレーションを足したときも同じコマンドで進める。

### 3. 一度デプロイして URL を確定させる

```bash
pnpm deploy   # web をビルド → 設定と secret を生成 → Worker ごと上げる
```

`https://ratatoskr.<subdomain>.workers.dev` が入口になる。この時点では **まだ誰でも開ける**が、
Access の値が空なので `/api/*` は全て 401 になり、記事は出ない。

### 4. Cloudflare Access を掛ける

Zero Trust ダッシュボード → **Access → Applications → Create new application → Self-hosted**。

| 項目                           | 値                                                             |
| ------------------------------ | -------------------------------------------------------------- |
| Application name               | `ratatoskr`                                                    |
| Destinations → Public hostname | `ratatoskr.<subdomain>.workers.dev`（3 で確定した入口）        |
| Identity providers             | Accept all available identity providers（または One-time PIN） |
| Policies                       | Action = Allow / Include = Emails → 自分のアドレス             |

**Workers & Pages の Worker → Access タブにある「Protect this Worker behind Access」は使わない。**
ホスト名ではなく Worker を宛先にするアプリが作られ、こちらの手元では PIN のメールが永久に届かない
状態になった（Destinations の preview が空のまま作られる）。ホスト名を宛先にした Self-hosted なら素直に通る。

作ったアプリの **Application Audience (AUD) Tag** と、Zero Trust のチームドメイン
（`<team>.cloudflareaccess.com`。ログイン画面の URL のホスト部分でも分かる）を `.prod.vars` に書く。

```
ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
ACCESS_AUD=<AUD Tag>
```

書いたらもう一度 `pnpm deploy`。Worker は `Cf-Access-Jwt-Assertion` の JWT を、このチームドメインが配る
公開鍵で検証し、`aud` が一致するものだけ通す（`src/lib/auth.ts`）。
**`ACCESS_AUD` を間違えると全ての API が 401 になる**ので、デプロイ後に画面を開いて記事が出ることを確かめる。

### 5. 動いていることを確かめる

```bash
# Access が掛かっていれば、ログイン画面へのリダイレクトか 403 が返る。
# 200 で {"ok":true} が読めるなら、まだ誰でも中身に触れる状態
curl -sS -o /dev/null -w '%{http_code}\n' https://<ホスト名>/api/health

pnpm exec wrangler tail   # cron の実行ログ（crawl / purge）を眺める
```

`/api/health` はアプリ側では認証を通していない（Access の設定を壊したときに切り分けられるように）。
外から触れないのは Access が前段で止めているからで、**そこが外れていれば素通しになる**ので、上の確認は必ず行う。
そのうえでブラウザで開き、Access のログインを通した先で記事が読めることまで見る。

購読は画面の「購読管理」から追加するか、他のリーダーから書き出した OPML を取り込む。
記事が入るのは次の定期取得（5 分毎の cron）だが、追加した分はその場で 1 回取りに行く。

### 定期実行

`wrangler.jsonc` の `triggers.crons` に 2 つ登録してある。デプロイと同時に有効になる。

| cron          | 仕事                                        |
| ------------- | ------------------------------------------- |
| `*/5 * * * *` | フィードの取得（1 回 20 フィードまで）      |
| `23 17 * * *` | 保持期間を過ぎた既読記事の削除（02:23 JST） |

無料プランは **1 アカウントあたり cron 5 個まで**なので、他の Worker と合わせて足りなければ
デプロイの最後で「Cron schedules」だけが失敗する（Worker 本体は上がっている）。

### 消してしまったときの戻し方

Worker を消すと、それに紐づく secret も一緒に消える。D1 は別のリソースなので残る。
`.prod.vars` さえ手元にあれば、次の 1 つで完全に戻せる。

```bash
pnpm deploy   # Worker・cron・secret がまとめて復旧する
```

Access のアプリケーションは Worker とは別に残るので、作り直す必要はない
（ただし作り直した場合は AUD が変わるので `.prod.vars` を更新する）。

## バックアップ

**失うと取り返しがつかないのは「購読リスト・既読位置・ピン」の 3 つだけ**で、記事本文はフィードから入り直す。
この前提で、次の 3 段を用意する。

| 手段                               | 守れる範囲                                          | 復旧の粒度                 |
| ---------------------------------- | --------------------------------------------------- | -------------------------- |
| D1 Time Travel                     | 直近 30 日（Workers 無料プランは 7 日）の任意の時点 | データベース全体           |
| `wrangler d1 export` の SQL ダンプ | 取った時点                                          | データベース全体           |
| OPML の書き出し                    | 購読リストのみ                                      | 購読の URL・名前・フォルダ |

### 事故ってから 30 日以内なら Time Travel

D1 は自動で履歴を持っている。バックアップを取っていなくても、時点を指定して戻せる。

```bash
pnpm exec wrangler d1 time-travel info ratatoskr                     # いまのブックマーク
pnpm exec wrangler d1 time-travel info ratatoskr --timestamp=<ISO8601>
pnpm exec wrangler d1 time-travel restore ratatoskr --timestamp=<ISO8601>
```

**restore は上書き**なので、戻す前に下のダンプを取っておく（戻した後に「やっぱり戻す前が良かった」が効かなくなる）。

### 手元に置く定期ダンプ

```bash
pnpm exec wrangler d1 export ratatoskr --remote --output "backup-$(date +%Y%m%d).sql"
```

30 日を超えて遡りたいとき（うっかり大量の購読を解除した、など）はこれしかない。月 1 回も取れば足りる。
`--no-data` を付ければスキーマだけ、`--no-schema` なら中身だけ取れる。

### 購読リストだけの控え

画面の購読管理から **OPML を書き出す**（`GET /api/opml`）。
リーダーを乗り換えるときも、まっさらな環境に入れ直すときもこれが起点になる。既読位置とピンは含まれない。

## ライセンス

MIT License（[LICENSE](LICENSE)）。
