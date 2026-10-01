-- 保持期間で消した記事の「消した」という印（docs/DESIGN.md §3「保持期間」）。
--
-- 同一性判定（idx_entries_guid と INSERT OR IGNORE）は、残っている行しか見ない。
-- 30 日より古い記事を配り続けるフィードでは、読んで消えた記事が次の取得で新規として
-- 入り直し、新しい id を採番されて未読に戻る。個人のブログの多くは直近 N 件を
-- 期間によらず配るので、本番では保持期間が効き始めた日に 19 フィード約 550 件が
-- 一斉に入り直した。
--
-- そこで、記事を消すときに (feed_id, guid_hash) だけをここへ残し、取り込み時に
-- ここも照合する（src/db/entries.ts の deleteExpiredEntries と insertEntries）。
--
-- 行は掃除しない。本文を持たないので 1 行 100 バイトに満たず、記事 1 件（本番の平均で
-- 約 13KB）の 1% 未満。フィードが配らなくなった記事の印は要らなくなるが、それを
-- 見分けるには取得のたびに書き込みが要る。購読を解除すれば CASCADE で消える。
CREATE TABLE entry_tombstones (
  feed_id    INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
  guid_hash  TEXT    NOT NULL,

  -- 今は読まない。後から古い印を掃除したくなったときに、これが無いと古さを知る手段が無い
  deleted_at INTEGER NOT NULL,

  PRIMARY KEY (feed_id, guid_hash)
) WITHOUT ROWID;
