# Ratatoskr

[![CI](https://github.com/kan/ratatoskr/actions/workflows/ci.yml/badge.svg)](https://github.com/kan/ratatoskr/actions/workflows/ci.yml)
[![last commit](https://img.shields.io/github/last-commit/kan/ratatoskr)](https://github.com/kan/ratatoskr/commits/main)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflareworkers&logoColor=white)](https://developers.cloudflare.com/workers/)
[![license](https://img.shields.io/github/license/kan/ratatoskr)](LICENSE)

個人用のセルフホスト型 RSS リーダー。Cloudflare Workers + D1 の上で動き、PC とスマートフォンから同じ購読状態を共有する。

目標は一つだけで、**livedoor Reader / Fastladder の「流れるように読める」操作感を Web で再現すること**。キーを押してから次の記事が出るまでの遅延がゼロであることを、機能の豊富さや見た目より優先する。

名前は、北欧神話でユグドラシルを往き来してメッセージを運ぶリスに由来する。

## 現在の状態

MVP（M0〜M9）は完了していて、購読の追加からスマホでのオフライン読みまで一通り動く。
以降は使っていて気付いたところを issue 単位で直している。実装順と、各マイルストーンで
決めたことは [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

## できること

- **キーボードだけで読み切る。** `j` / `k` で記事、`s` / `a` でフィード、`Space` で
  スクロールと次の記事、`Shift+S` でそのフィードを全部既読。`?` で一覧が出る
  （定義は `web/src/lib/keymap.ts` の 1 箇所にあり、ヘルプはそこから作られる）
- **既読が端末をまたいで揃う。** PC で読んだ続きをスマホで開ける。`u` を押せば
  その 1 件だけ未読に戻せて、それも端末をまたぐ
- **購読の管理。** 追加・解除、レート（読む順）、フォルダでの絞り込み、OPML の入出力。
  いま見ているサイトの RSS は、ブックマークレットから登録できる
- **ピン。** 後で読む記事に `p` を立て、`z` で一覧、`o` でまとめてタブに開く。
  サーバに持つので、スマホで立てて PC で開ける
- **要約しか配信していないフィードの全文取得。** 本文がページのどこにあるかを
  Workers AI に 1 フィードにつき 1 回だけ判定させ、以降はその選択子で引く
- **先読み。** 次の記事も、その画像も、送る前に手元へ来ている（仕組みは下の「設計の中核」）
- **スマホと PWA。** ホーム画面に追加でき、圏外でも起動して読める。
  読んだ分とピンは、繋がった時点でまとめて送られる
- **放っておいても壊れない。** 5 分毎の取得、保持期間を過ぎた記事の掃除（サーバと手元の両方）、
  取得が止まったフィードの警告、新着が来たことのタブアイコンでの通知

## 設計の中核

- **既読はウォーターマーク方式**。記事ごとの既読フラグを持たず、フィードごとに「既読済みの最大 entry id」を 1 つ持つ。更新は常に `MAX` なので単調増加し、複数端末の衝突解決が `Math.max` だけで済む
- **起動時に記事本文を全件先落とし**する。想定規模（50〜150 フィード）なら手元に置けるので、記事送りがネットワークを待たない
- **書き込みは outbox 経由**。既読・ピン・レート変更はローカルに即時反映し、送信は非同期・冪等

詳細は [docs/DESIGN.md](docs/DESIGN.md)、操作系は [docs/UX.md](docs/UX.md)、API は [docs/API.md](docs/API.md) に書いてある。

## 技術スタック

Cloudflare Workers (Static Assets) / D1 / Cron Triggers / Workers AI / Vue 3 + TypeScript / Vite / Pinia / Tailwind CSS v4 / IndexedDB / Service Worker / Cloudflare Access

## 開発

```bash
pnpm install
cp .dev.vars.example .dev.vars   # Access の値を埋める（検証を飛ばすのは pnpm dev の --var）
cp .env.example .env             # Workers AI の接続に要る（下記。デプロイ後だけ）
pnpm db:migrate                  # ローカル D1 にスキーマを適用
pnpm build                       # web/dist を作る（下記。初回だけ）
pnpm dev                         # vite(5173) と wrangler dev(8787) を同時起動
```

画面は http://localhost:5173 を開く。`/api` は 8787 の Worker にプロキシされる（本番は同一オリジン）。

初回に `pnpm build` を挟むのは、`wrangler.jsonc` が Static Assets の置き場として `web/dist` を
指しているため。**クローン直後は `web/dist` が無く、`wrangler dev` が
「The directory specified by the "assets.directory" field ... does not exist」で起動しない。**
開発中の画面は vite が配るので、ここで作った `dist` は中身が古くても構わない。

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
| `pnpm test:e2e`         | Playwright（キーバインドの確認）   |
| `pnpm typecheck`        | `tsc` + `vue-tsc`                  |
| `pnpm lint`             | ESLint + Prettier                  |
| `pnpm db:console "SQL"` | ローカル D1 に SQL を投げる        |

### CI とセキュリティ

`main` への push と、あらゆる PR（Dependabot のものを含む）で、`.github/workflows/ci.yml` が上の
`lint` / `typecheck` / `test` / `test:e2e` を回す。**Cloudflare の資格情報は要らない**
（理由は `vitest.config.ts` と `playwright.config.ts` のコメント）。

依存の更新は Dependabot が週 1 で PR にする（`.github/dependabot.yml`）。minor と patch は
1 本にまとめ、TypeScript の major だけは除外している（vue-tsc が TS 7 に未対応）。

脆弱性の報告先と、何を脆弱性として扱うかは [SECURITY.md](SECURITY.md) を参照。

## デプロイ

セルフホストなので、Cloudflare のアカウント 1 つに自分用の 1 台を立てる。所要は初回で 15 分ほど。

道は 2 つある。**どちらで入れても、最後に Cloudflare Access を自分で掛ける**ことになる。
入口を塞がなければ誰でも中身を読めるし、Access の AUD はアプリを作るまで決まらないので、
そこだけはボタンにも肩代わりできない。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kan/ratatoskr)

### ボタンで入れる

押すと Cloudflare が次を代わりにやる。

- このリポジトリを自分の GitHub アカウントへクローンする
- `wrangler.jsonc` を読んで D1（`ratatoskr`）を用意し、`database_id` をクローン先の設定に書き戻す
- `package.json` の `build` と `deploy` を拾って設定画面に埋め、そのまま実行する。
  `pnpm deploy` はマイグレーションを当ててから上げるので、空のデータベースに新しいコードが向かわない
- `.dev.vars.example` に並んでいる名前を尋ねる

**Access の値はこの時点では埋められない。** `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` は
アプリを作ってから決まる値なので、空のまま進めてよい（その間 `/api/*` は全て 401 を返し、
画面は開くが記事は出ない）。デプロイが終わったら下の「Access を掛ける」に進む。

**入れ直す先は Worker の設定ではなく、ビルドの設定。** `pnpm deploy` はデプロイのたびに
この 2 つを設定ごと渡し直す（Worker を消しても 1 コマンドで戻せるようにするため）。
Worker 側にだけ入れても、次のビルドで空に戻る。
**Settings → Build → Build Variables and Secrets** に 2 つを入れてから、もう一度ビルドを回す。

以降は自分のアカウントのクローンが正本になる。この本家を追いかけたければ、
そちらへ upstream として繋いで取り込む。

### 手元から入れる

作者はこちらで運用している。**アカウント固有の値を追跡させない**のがこの経路の要で、
`database_id` も Access の値も git 管理外の `.prod.vars` にだけ置く。

#### 1. D1 を作る

```bash
pnpm exec wrangler d1 create ratatoskr
```

出力された id を、git 管理外の `.prod.vars` に置く。**アカウント固有の値はこのファイルにだけ書く。**

```bash
cat > .prod.vars <<'EOF'
D1_DATABASE_ID=<wrangler d1 create の出力の id>

# Access の値。この時点ではまだ分からないので空でよい（下の「Access を掛ける」で入れる）
ACCESS_TEAM_DOMAIN=
ACCESS_AUD=
EOF
```

`pnpm deploy` は毎回ここから `wrangler.deploy.json`（git 管理外）を組み立てる。
`wrangler.jsonc` に `database_id` と Access の 2 つを差し込んだものだ。

- アカウント固有の値を設定ファイルに書かないのは、公開リポジトリに残さないため。
  `database_id` はデプロイ時に必須で、データベース名だけでは解決されない
- Access の 2 つを secret ではなく `vars` に置いてあるのは、**デプロイのたびに必ず渡すから**。
  secret は「渡さなければ前の版から引き継ぐ」仕組みなので、Worker がまだ無い初回デプロイでは
  引き継ぎ元が無くて止まる。毎回渡すなら secret の利点（消えない）は得られず、初回が詰む欠点だけが残る
- おかげで、**Worker を作り直しても `.prod.vars` さえあれば 1 コマンドで元に戻る**

#### 2. 一度デプロイして URL を確定させる

```bash
pnpm deploy   # web をビルド → 設定を生成 → migrations を当てる → Worker ごと上げる
```

マイグレーションはデプロイに含めてある。当て直すだけなら `pnpm db:migrate:remote` を単体で回せる。

D1 を指すコマンドは、データベース名ではなく**バインディング名 `DB`** で揃えてある
（`wrangler.jsonc` の `d1_databases[].binding`）。ボタン経由のクローンでは
データベース名が変わり得るが、バインディングはリポジトリ側が決めるので変わらない。

`https://ratatoskr.<subdomain>.workers.dev` が入口になる。この時点では **まだ誰でも開ける**が、
Access の値が空なので `/api/*` は全て 401 になり、記事は出ない。

### Cloudflare Access を掛ける（どちらの道でも要る）

Zero Trust ダッシュボード → **Access → Applications → Create new application → Self-hosted**。

| 項目                           | 値                                                             |
| ------------------------------ | -------------------------------------------------------------- |
| Application name               | `ratatoskr`                                                    |
| Destinations → Public hostname | `ratatoskr.<subdomain>.workers.dev`（デプロイで確定した入口）  |
| Identity providers             | Accept all available identity providers（または One-time PIN） |
| Policies                       | Action = Allow / Include = Emails → 自分のアドレス             |

**Workers & Pages の Worker → Access タブにある「Protect this Worker behind Access」は使わない。**
ホスト名ではなく Worker を宛先にするアプリが作られ、こちらの手元では PIN のメールが永久に届かない
状態になった（Destinations の preview が空のまま作られる）。ホスト名を宛先にした Self-hosted なら素直に通る。

作ったアプリの **Application Audience (AUD) Tag** と、Zero Trust のチームドメイン
（`<team>.cloudflareaccess.com`。ログイン画面の URL のホスト部分でも分かる）を Worker に入れる。

- 手元から入れたなら `.prod.vars` に書いて、もう一度 `pnpm deploy`

  ```
  ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
  ACCESS_AUD=<AUD Tag>
  ```

- ボタンで入れたなら **Settings → Build → Build Variables and Secrets** に同じ名前の 2 つを
  置いて、もう一度ビルドを回す（Worker の設定に直接入れても、次のビルドで空に戻る）

Worker は `Cf-Access-Jwt-Assertion` の JWT を、このチームドメインが配る公開鍵で検証し、
`aud` が一致するものだけ通す（`src/lib/auth.ts`）。
**`ACCESS_AUD` を間違えると全ての API が 401 になる**ので、入れた後に画面を開いて記事が出ることを確かめる。

### 動いていることを確かめる

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

Worker を消すと、それに紐づく設定も一緒に消える。D1 は別のリソースなので残る。
`.prod.vars` さえ手元にあれば、次の 1 つで完全に戻せる。

```bash
pnpm deploy   # Worker・cron・Access の値がまとめて復旧する
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
pnpm exec wrangler d1 time-travel info DB                     # いまのブックマーク
pnpm exec wrangler d1 time-travel info DB --timestamp=<ISO8601>
pnpm exec wrangler d1 time-travel restore DB --timestamp=<ISO8601>
```

**restore は上書き**なので、戻す前に下のダンプを取っておく（戻した後に「やっぱり戻す前が良かった」が効かなくなる）。

### 手元に置く定期ダンプ

```bash
pnpm exec wrangler d1 export DB --remote --output "backup-$(date +%Y%m%d).sql"
```

30 日を超えて遡りたいとき（うっかり大量の購読を解除した、など）はこれしかない。月 1 回も取れば足りる。
`--no-data` を付ければスキーマだけ、`--no-schema` なら中身だけ取れる。

### 購読リストだけの控え

画面の購読管理から **OPML を書き出す**（`GET /api/opml`）。
リーダーを乗り換えるときも、まっさらな環境に入れ直すときもこれが起点になる。既読位置とピンは含まれない。

## ライセンス

MIT License（[LICENSE](LICENSE)）。
