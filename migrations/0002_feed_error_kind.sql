-- 取得に失敗した理由を機械的に扱えるようにする。
--
-- last_error は人が読むための文言なので、UI から「404 のフィードだけ」を選ぶ用途には
-- 使えない（文言を直すたびに選択条件が壊れる）。分類はクロール時にしか分からないので、
-- そのときに決めた値を残す。成功したら last_error と一緒に NULL に戻す。
--
-- 値: not_found / forbidden / server_error / not_a_feed / unreachable / timeout /
--     connection_lost / other
ALTER TABLE feeds ADD COLUMN last_error_kind TEXT;
