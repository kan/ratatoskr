-- Podcast の購読と文字起こし（issue #46。src/crawler/transcribe.ts）。

-- エピソードの音声（RSS の enclosure / Atom の rel="enclosure"）。音声でない記事は NULL。
--   audio_url … 音声ファイルの URL（http / https のみ）
--   audio_type … enclosure の type（audio/mpeg など）。無ければ NULL
--   audio_duration … 長さ（秒）。itunes:duration から。無ければ NULL
--   audio_chapters … チャプター（psc:chapters）の JSON。[{"start": 秒, "title": "…"}]。無ければ NULL
--
-- 本文（body）には入れない。サニタイズが audio 要素を落とすのと、再生の UI は画面が
-- 構造化した値から組み立てるため（v-html の中に再生器を置かない）
ALTER TABLE entries ADD COLUMN audio_url TEXT;
ALTER TABLE entries ADD COLUMN audio_type TEXT;
ALTER TABLE entries ADD COLUMN audio_duration INTEGER;
ALTER TABLE entries ADD COLUMN audio_chapters TEXT;

-- 文字起こしの結果のうち、記事に添えて配るもの。**記事の読み出しに表を足さない**ために
-- entries に持つ（翻訳の translated_* と同じ）。作業中の状態は下の transcripts に持つ。
--   transcript_state … NULL（始めていない）/ running / done / failed
--   transcript_summary … 要約の JSON。{"overview": "…", "sections": [{"start": 秒, "title": "…" | null, "text": "…"}]}。
--                        done のときだけ入る。HTML にしないのは、画面が時刻を再生位置へ
--                        飛ぶボタンとして組むため（LLM の出力を v-html に通さない）
ALTER TABLE entries ADD COLUMN transcript_state TEXT;
ALTER TABLE entries ADD COLUMN transcript_summary TEXT;

-- 文字起こしと要約をするか。**既定は 0 で、決めるのはユーザ。** Workers AI を音声の
-- 長さだけ使う（2 時間半のエピソード 1 本で 1 日の無料枠の 7 割）ので、こちらが勝手に
-- 始めない（翻訳の translate と同じ考え方）
ALTER TABLE feeds ADD COLUMN transcribe INTEGER NOT NULL DEFAULT 0;

-- 文字起こしを勧めたか。translate_suggested と同じ 3 値。
--   0 … まだ何も言っていない（音声付きの記事が届いたことが無い）
--   1 … 音声付きの記事が届いたので勧めている
--   2 … ユーザが決めた（二度と勧めない）
-- 0 でなければ Podcast とみなす（購読管理画面に「文字起こし」を出す）
ALTER TABLE feeds ADD COLUMN transcribe_suggested INTEGER NOT NULL DEFAULT 0;

-- 既存のフィードを 1 度だけ読み直させる。取り込みは INSERT OR IGNORE なので、
-- 音声の列ができる前から購読していた Podcast の記事は音声を持たないまま残る。
-- 変化が無いと見るとパースしない（条件付き GET と content_hash）ので、その控えを捨てる。
-- 音声付きの記事が初めて届いたフィードは、取り込み済みの記事にも音声を書き足す
-- （src/crawler/index.ts）
UPDATE feeds SET etag = NULL, last_modified = NULL, content_hash = NULL;

-- 文字起こしの作業中の状態。
--
-- **1 回の cron で 1 本を終えられないので、途中の状態を持つ。** 音声は Range で
-- 区切って取り、区切りごとに Workers AI に渡す（2 時間半で 100MB を超え、Worker の
-- メモリにもモデルの入力にも 1 度には載らない）。
--
--   next_byte … 次に取りに行く音声の先頭のバイト位置
--   total_bytes … 音声全体の大きさ。next_byte が届けば起こし終えている（要約だけが残っている
--                 ときに、音声を取り直さずに済む）。最初の区切りを取るまでは NULL
--   elapsed … ここまでに文字起こしした音声の長さ（秒）。次の区切りの時刻の起点
--   tail … 文字起こしの末尾（200 字）。次の区切りの文脈として Whisper に渡す
--   failures … 続けて失敗した回数。上限で諦める（entries.transcript_state を failed に）
--   error … 最後の失敗の理由
--
-- 記事が保持期間で消えれば一緒に消える
CREATE TABLE transcripts (
  entry_id INTEGER PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
  next_byte INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  elapsed REAL NOT NULL DEFAULT 0,
  tail TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL
);

-- 文字起こしの本体。区切り 1 つにつき 1 行で、後ろへ足すだけ（1 行に足していくと、
-- 区切りのたびに伸びた行全体を書き直すことになる）。
--   from_byte … その区切りの先頭のバイト位置。**cron が重なって同じ区切りを 2 度起こしても、
--               主キーに当たって 1 度しか入らない**
--   segments … 1 行 1 区間で「開始秒<TAB>テキスト」
CREATE TABLE transcript_parts (
  entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  from_byte INTEGER NOT NULL,
  segments TEXT NOT NULL,
  PRIMARY KEY (entry_id, from_byte)
);
