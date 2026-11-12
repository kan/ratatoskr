-- 取り込んだ後で本文が変わった時刻（Unix 秒）。NULL なら取り込んだときのまま。
--
-- 全文（full_body）は記事を入れた後で埋まる。予算切れや Bluesky の返信待ちで次の
-- クロールまで持ち越すこともある。その間に差分同期が記事を持っていくと、端末は
-- 全文の前の本文を持ったままになる。差分同期は entryCursor より新しい記事しか
-- 返さないので、後から全文が入っても届かない。GET /api/sync がこの列を since と
-- 比べて、本文が変わった記事を別に返す（docs/API.md）。
--
-- 刻むのは読み出し（COALESCE(NULLIF(full_body, ''), body)）が変わるときだけ。
-- full_body に '' の印を付けるのと、その印を消すのでは、読み出しは変わらない
ALTER TABLE entries ADD COLUMN body_updated_at INTEGER;

-- 差分同期は「since 以降に変わった記事」を毎回引く。部分索引なので、全文取得を
-- 使わない限り実体はほぼ空
CREATE INDEX idx_entries_body_updated_at ON entries (body_updated_at)
  WHERE body_updated_at IS NOT NULL;
