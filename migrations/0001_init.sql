-- Ratatoskr initial schema
--
-- 設計の根拠は docs/DESIGN.md を参照。特に以下の 2 点は変更しないこと:
--   - entries.id は AUTOINCREMENT。この採番順が「読む順序」と「未読判定」の両方を担う
--   - 未読判定は entries.id > feeds.read_seq。記事ごとの既読フラグは持たない
--
-- 時刻は全て Unix 秒（整数）。

-- ---------------------------------------------------------------------------
-- feeds: 購読 1 件につき 1 行
-- ---------------------------------------------------------------------------
CREATE TABLE feeds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  url                  TEXT    NOT NULL UNIQUE,       -- フィード URL
  site_url             TEXT,                          -- サイトの URL
  title                TEXT    NOT NULL DEFAULT '',
  icon_url             TEXT,
  rate                 INTEGER NOT NULL DEFAULT 3,    -- 1..5。読む順を決める
  folder               TEXT    NOT NULL DEFAULT '',   -- '' は未分類

  -- 既読ウォーターマーク。既読済みの最大 entries.id
  -- 更新は必ず UPDATE feeds SET read_seq = MAX(read_seq, ?) で行うこと
  read_seq             INTEGER NOT NULL DEFAULT 0,

  -- クロール制御
  etag                 TEXT,
  last_modified        TEXT,
  content_hash         TEXT,                          -- 304 を返さないサーバ向け
  next_fetch_at        INTEGER NOT NULL DEFAULT 0,
  fetch_interval       INTEGER NOT NULL DEFAULT 900,  -- 秒。初期値 15 分
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_fetched_at      INTEGER,

  disabled             INTEGER NOT NULL DEFAULT 0,    -- 0/1
  created_at           INTEGER NOT NULL,

  CHECK (rate BETWEEN 1 AND 5),
  CHECK (disabled IN (0, 1))
);

-- cron が「取得すべきフィード」を引くための索引
CREATE INDEX idx_feeds_next_fetch ON feeds (next_fetch_at) WHERE disabled = 0;

-- 左ペインの並び順（レート降順 → 未読数降順）の前段
CREATE INDEX idx_feeds_rate ON feeds (rate DESC);

-- ---------------------------------------------------------------------------
-- entries: 記事 1 件につき 1 行
-- ---------------------------------------------------------------------------
CREATE TABLE entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id      INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,

  -- guid / link / (title + published) の優先順で選んだ値の SHA-256
  guid_hash    TEXT    NOT NULL,

  url          TEXT,
  title        TEXT    NOT NULL DEFAULT '',
  author       TEXT,

  -- サニタイズ済み HTML のみを格納する。生のフィード HTML を入れないこと
  body         TEXT    NOT NULL DEFAULT '',

  -- 表示にのみ使う。順序判定には使わない（NULL でも実害がない）
  published_at INTEGER,

  stored_at    INTEGER NOT NULL
);

-- 同一記事の再取り込みを防ぐ。INSERT OR IGNORE と対で使う
CREATE UNIQUE INDEX idx_entries_guid ON entries (feed_id, guid_hash);

-- 未読抽出 (feed_id = ? AND id > read_seq) と未読数集計を賄う
CREATE INDEX idx_entries_feed_id ON entries (feed_id, id);

-- 保持期間による削除で使う
CREATE INDEX idx_entries_stored_at ON entries (stored_at);

-- ---------------------------------------------------------------------------
-- entry_states: ウォーターマークから逸脱する記事だけを記録する例外テーブル
--
-- 「一度既読になったが手動で未読に戻した記事」のみ行が存在する。
-- 全記事分の行は作らない。
-- ---------------------------------------------------------------------------
CREATE TABLE entry_states (
  entry_id   INTEGER PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
  unread     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,

  CHECK (unread IN (0, 1))
);

-- ---------------------------------------------------------------------------
-- pins: 記事の保持期間より長く生き残る
--
-- そのため title / url を非正規化して持つ。記事が削除されても entry_id が
-- NULL になるだけでピン自体は残る（ON DELETE SET NULL）。
-- ---------------------------------------------------------------------------
CREATE TABLE pins (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id  INTEGER REFERENCES entries (id) ON DELETE SET NULL,
  title     TEXT    NOT NULL,
  url       TEXT    NOT NULL UNIQUE,   -- 重複ピンは INSERT OR REPLACE で吸収
  pinned_at INTEGER NOT NULL
);

CREATE INDEX idx_pins_pinned_at ON pins (pinned_at DESC);

-- ---------------------------------------------------------------------------
-- 参考クエリ
-- ---------------------------------------------------------------------------

-- 未読数の集計:
--   SELECT f.id, COUNT(e.id) AS unread_count
--   FROM feeds f
--   LEFT JOIN entries e ON e.feed_id = f.id AND e.id > f.read_seq
--   WHERE f.disabled = 0
--   GROUP BY f.id;

-- 既読化（必ず MAX を使う）:
--   UPDATE feeds SET read_seq = MAX(read_seq, ?) WHERE id = ?;

-- 保持期間による削除:
--   DELETE FROM entries
--   WHERE id <= (SELECT read_seq FROM feeds WHERE id = entries.feed_id)
--     AND stored_at < ?
--     AND id NOT IN (SELECT entry_id FROM pins WHERE entry_id IS NOT NULL);
