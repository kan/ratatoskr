# セキュリティ方針

Ratatoskr は個人用のセルフホスト型 RSS リーダーです。公開のサービスを運用しているわけではなく、
使う人がそれぞれ自分の Cloudflare アカウントへデプロイします。したがってここで扱うのは
**このリポジトリのコードと、README の手順どおりに構築した環境**の話です。

## 対象のバージョン

`main` のみです。リリースタグを切っておらず、過去のコミットへ修正を戻すこともしません。

| バージョン | 対応   |
| ---------- | ------ |
| `main`     | する   |
| それ以外   | しない |

## 報告のしかた

**issue には書かないでください。** GitHub の Private vulnerability reporting を使ってください。

https://github.com/kan/ratatoskr/security/advisories/new

個人プロジェクトなので対応時期は約束できません。目安として、受け取ったことの返事は 1 週間以内、
直すかどうかの判断はその後にお知らせします。修正したら advisory を公開します。

報告には次を含めてもらえると助かります。

- 再現手順（可能なら最小のもの）
- 影響（何が読めるか、何が書けるか）
- 対象のコミット

## 想定している脅威と、していないもの

デプロイ後の入口は Cloudflare Access で塞ぐ前提です（README「デプロイ」）。Access を掛けずに
公開したままにすると誰でも中身に触れますが、それは設定の問題で、脆弱性としては扱いません。

以下は脆弱性として扱います。

- **記事本文の XSS。** `entries.body` は取り込み時にサーバ側でサニタイズしたものだけを保存し、
  画面は `v-html` で描く。DB の中身が信頼できることが安全性の全てなので、サニタイズを
  すり抜ける入力は重大な問題です
- Access の検証（`src/lib/auth.ts`）を迂回できる経路。`ACCESS_DEV_BYPASS` は localhost 宛の
  要求にしか効かないようにしてありますが、これが本番でも効く経路があれば脆弱性です
- 他人のフィード・既読位置・ピンを読み書きできる経路
- 取り込んだフィードの内容によって、Worker 側で意図しない取得や書き込みが起きるもの（SSRF 等）

以下は対象外です。

- 自分でデプロイした環境の設定不備（Access を掛けていない、secret を公開した、など）
- 依存ライブラリの既知の脆弱性そのもの。これは Dependabot alerts で追っています。ただし
  **このコードの使い方が原因で悪用可能になっている**場合は報告してください
- 実際の悪用につながらないスキャナの出力

## 有効にしている仕組み

- Dependabot alerts / security updates（依存の既知脆弱性）
- CodeQL のコードスキャン（default setup）
- Secret scanning と push protection（秘密の混入を push の時点で止める）
- CI（`.github/workflows/ci.yml`）で lint・型・ユニット・E2E を回す

---

## English

Ratatoskr is a personal, self-hosted RSS reader. Only `main` is supported. Please report
vulnerabilities through GitHub's private vulnerability reporting
(https://github.com/kan/ratatoskr/security/advisories/new) rather than public issues. This is a
side project, so no response time is guaranteed; expect an acknowledgement within a week.
