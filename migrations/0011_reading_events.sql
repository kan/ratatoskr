-- 読み方のデータ（issue #43）。何をどれだけ読んだかを、後から使えるように貯める。
--
-- 最初の使い道は「ほとんど読まずに送っているフィードに、レートの引き下げや解除を
-- 勧める」こと（feeds.skimmed）。推薦は docs/DESIGN.md の目標外なので、ここで貯めた
-- ものを推薦に使うかどうかは別に決める。
--
-- id … 端末が振る（UUID）。outbox の再送で同じ行が二度入らないようにするための鍵
-- kind … dwell（記事を表示していた時間）/ link（本文のリンクを開いた）/ open（元記事を開いた）
--
-- **記事より長生きするので、記事の中身を写して持つ。** 記事は保持期間で消えるので、
-- entry_id だけでは後から何の記事だったか分からない。フィードを消しても残す
-- （外部キーにしない）
CREATE TABLE reading_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  feed_id INTEGER,
  entry_id INTEGER,
  feed_title TEXT,
  entry_title TEXT,
  entry_url TEXT,
  -- link のときの開いた先
  target_url TEXT,
  -- dwell のときの秒数
  seconds INTEGER
);

-- フィードごとの集計（skimmed の判定）と、保持期間の掃除に使う
CREATE INDEX idx_reading_events_feed_at ON reading_events (feed_id, at);
CREATE INDEX idx_reading_events_at ON reading_events (at);

-- ほとんど読まずに送っているフィードか（1 日 1 回の掃除の cron で付け直す）。
-- 購読管理画面で、レートを下げるか解除することを勧めるのに使う
ALTER TABLE feeds ADD COLUMN skimmed INTEGER NOT NULL DEFAULT 0;
