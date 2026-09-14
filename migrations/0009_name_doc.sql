-- 公開名変換の「名前の場所を記号で持つ方式」（公開名変換設計・記号方式 §2.2）。2026-09-14。
-- 適用: npm run db:migrate:name-doc:local / npm run db:migrate:name-doc:remote
-- ⚠️ 足すだけ。IF NOT EXISTS なので再適用しても壊れない。既存の表には一切手を入れていない
--    （古いコードのまま当てても動く。古い表 name_choice・description_name_choice・publish_body は 0010 で捨てる）。
--
-- ⚠️⚠️ ここには DDL だけを書く。辞書の中身・選択・文は絶対に書かない（このリポジトリは public）。
--
-- 文書（name_doc）= 名前の場所を記号で持った文。segments は {"v":1,"s":[{"t":"文字"},{"r":"記号の id"}]}。記号に実名を入れない。
--   kind = 'kakera'      原本の本文の影（kakera.body が正。「実名で解いた文 ＝ 今の文」でなければ差分で作り直す）
--   kind = 'title'       日記のタイトルの影（前回使ったタイトル）
--   kind = 'description' 説明文の影（katachi.description が正。空なら文書を持たない）
--   kind = 'publish'     日記用に直した文（文書そのものが正。basis = 書き換えた／「書き換えを使う」を選んだ時点の kakera.updated_at）
--   dict_sig = 作り直した時点の辞書の置き換え元の SHA-256（置き換え先は含めない）
--   rev      = 文の形を書き換えるたびに新しい ULID（開いた後に中身が変わったら書き出し・日記用の保存を 409 で止める）
-- 記号（name_ref）= 置き換え元（実名）と選択。辞書どおり（approve）も行を持つ。★実名を含むので D1 にだけ置く

CREATE TABLE IF NOT EXISTS name_doc (
  id          TEXT PRIMARY KEY,   -- ULID
  kind        TEXT NOT NULL CHECK (kind IN ('kakera', 'title', 'description', 'publish')),
  kakera_id   TEXT REFERENCES kakera(id) ON DELETE CASCADE,
  katachi_id  TEXT REFERENCES katachi(id) ON DELETE CASCADE,
  segments    TEXT NOT NULL,      -- JSON。実名を含まない
  dict_sig    TEXT NOT NULL,
  rev         TEXT NOT NULL,
  basis       TEXT,               -- publish だけ
  updated_at  TEXT NOT NULL,      -- 文の形を書き換えた時刻（ISO8601 JST）
  CHECK (
    (kind = 'kakera' AND kakera_id IS NOT NULL AND katachi_id IS NULL AND basis IS NULL) OR
    (kind IN ('title', 'description') AND katachi_id IS NOT NULL AND kakera_id IS NULL AND basis IS NULL) OR
    (kind = 'publish' AND katachi_id IS NOT NULL AND kakera_id IS NOT NULL AND basis IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_doc_kakera      ON name_doc(kakera_id)             WHERE kind = 'kakera';
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_doc_title       ON name_doc(katachi_id)            WHERE kind = 'title';
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_doc_description ON name_doc(katachi_id)            WHERE kind = 'description';
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_doc_publish     ON name_doc(katachi_id, kakera_id) WHERE kind = 'publish';

CREATE TABLE IF NOT EXISTS name_ref (
  id          TEXT PRIMARY KEY,   -- ULID。segments の r
  doc_id      TEXT NOT NULL REFERENCES name_doc(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,      -- 置き換え元（その場所に書かれていた実名＝辞書の語）
  action      TEXT NOT NULL DEFAULT 'approve' CHECK (action IN ('approve', 'edit', 'reject')),
  text        TEXT,               -- edit のときの言葉
  updated_at  TEXT NOT NULL,
  CHECK ((action = 'edit') = (text IS NOT NULL AND text != ''))
);
CREATE INDEX IF NOT EXISTS idx_name_ref_doc ON name_ref(doc_id);
