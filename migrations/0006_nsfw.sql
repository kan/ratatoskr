-- フィード単位の NSFW の印（issue #23）。
--
-- 印の付いたフィードは、表示を有効にした端末でしか出さない。**隠すのは画面側で、
-- サーバは全ての端末に同じものを配る**（docs/DESIGN.md §6「NSFW」）。どの端末で
-- 出すかは端末ごとの設定（localStorage）なので、こちらには持たない。
--
-- 既定は 0。決めるのはユーザ
ALTER TABLE feeds ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1));

-- ピンにも同じ印を持つ。**ピンは記事より長生きする**ので、記事が保持期間で消えた後は
-- どのフィードの記事だったかを引けない（entry_id が NULL になる）。title / url と同じく、
-- ピンを立てた時点のフィードの印を写しておく（src/db/pins.ts の insertPin）。
--
-- フィードの印を後から変えたときは、記事がまだ残っているピンにだけ追随させる
-- （src/db/feeds.ts の updateFeedSettings）。記事が消えたピンは立てた時点の印のまま
ALTER TABLE pins ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1));
