-- 日本語以外の記事を訳す（issue #42。src/crawler/translate.ts）。

-- 訳すか。**既定は 0 で、決めるのはユーザ。** Workers AI の無料枠を記事の数だけ使う
-- 動作なので、こちらが勝手に始めない（全文取得の full_text と同じ考え方）
ALTER TABLE feeds ADD COLUMN translate INTEGER NOT NULL DEFAULT 0;

-- 訳すことを勧めたか。full_text_suggested と同じ 3 値。
--   0 … まだ何も言っていない
--   1 … クロール時に「日本語ではない」と見えたので勧めている
--   2 … ユーザが決めた（二度と勧めない）
ALTER TABLE feeds ADD COLUMN translate_suggested INTEGER NOT NULL DEFAULT 0;

-- 訳した見出しと本文（本文はサニタイズ済み HTML のみ。不変条件 4）。
--   NULL … まだ訳していない
--   ''   … 訳さないと決めた（日本語だった・応答が読めなかった）。二度と拾わない
--   その他 … 訳文
--
-- **原文（body / full_body）は上書きしない。** 原文も読めるようにするのと、訳すのを
-- やめたときに元へ戻せるようにするため。全文が後から入ったときは訳し直す
-- （src/db/entries.ts の updateFullBodies が NULL に戻す）
ALTER TABLE entries ADD COLUMN translated_title TEXT;
ALTER TABLE entries ADD COLUMN translated_body TEXT;
