-- guid だけを付け替えて同じ記事を配り直すフィードのために、取り込み時に
-- 「同じフィードに URL とタイトルが同じ記事があるか」を確かめる（issue #18。
-- 理由は docs/DESIGN.md §3、照合は src/db/entries.ts の insertEntries）。
--
-- この照合は取り込む記事ごとに毎クロール走る。title まで索引に入れるのは、
-- 全ての記事が同じ URL を持つフィードで、同じ URL の行を毎回全部読まないため
CREATE INDEX idx_entries_feed_url_title ON entries (feed_id, url, title);
