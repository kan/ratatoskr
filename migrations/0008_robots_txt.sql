-- robots.txt の控え（issue #39）。
--
-- 全文取得の記事ページと、RSS を出さないサイトのページを取りに行く前に、そのサイトの
-- robots.txt（RFC 9309）を見る。フィード本体は利用者が明示的に購読したものなので
-- 対象にしない（一般的なフィードリーダーの扱いに合わせる）。
--
-- 記事ページは cron のたびに数件ずつ取りに行くので、その都度 robots.txt を引くと
-- 記事ページと同じ数だけ余計な要求が増える。RFC 9309 が認める上限（24 時間）まで
-- 控えておく。
--
-- origin … `https://example.com`（スキーム・ホスト・ポート）。robots.txt はこの単位で効く
-- state  … ok（body の規則に従う）/ allow_all（4xx。置いていない）/ disallow_all（5xx・接続できない）
-- body   … state が ok のときの中身（先頭 500 KiB まで）。それ以外は ''
CREATE TABLE robots_txt (
  origin TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 全文取得で、記事ページの取得が robots.txt に禁じられていたか。
-- 購読管理画面で「全文取得を入れたのに埋まらない」理由を見せるために持つ。
-- 記事ページが取れたら 0 に戻す（サイトが robots.txt を緩めたとき）
ALTER TABLE feeds ADD COLUMN full_text_blocked INTEGER NOT NULL DEFAULT 0;
