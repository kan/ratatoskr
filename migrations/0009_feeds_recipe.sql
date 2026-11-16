-- RSS を出さないサイトの取得定義（issue #40。src/crawler/recipe.ts）。
--
-- 記事の一覧をどう組み立てるかを JSON で持つ。NULL なら今までどおり、URL で決まる
-- 取り込み口（既知のソースか RSS）で読む。
--
-- **URL から決まらない値なので列に持つ。** 既知のソース（アイドルマスター公式など）は
-- URL から一意に決まるので種別の列を持たなかったが、取得定義は同じ URL でも作り方で
-- 中身が変わる（docs/DESIGN.md「ソースはフィードの URL で決める」の例外）
ALTER TABLE feeds ADD COLUMN recipe TEXT;

-- 取得定義を誰が作ったか。
--   ai / score … 購読の追加で、ページから推定した（AI が選んだか、点数の 1 位か）
--   manual     … 開発時に調べて書いたものを貼った
--
-- 推定したものは、記事が取れなくなったら取り込みの中で推定し直す。手で書いたものは
-- 推定し直さない（推定で作れないから手で書いている）。失敗として記録して人に知らせる
ALTER TABLE feeds ADD COLUMN recipe_source TEXT;
