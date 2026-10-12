-- 写真の顔の枠と、顔の検出が済んだ印（顔モザイク設計 §3.2）。
-- 適用: npm run db:migrate:photo-face:local / npm run db:migrate:photo-face:remote
-- ⚠️ DDL だけ。IF NOT EXISTS なので再適用しても壊れない。既存の表には一切手を入れていない。
--
-- 決まり:
--   - 枠は写真の key（kakera-photos の key）に紐づける（かけら単位ではない）。
--     同じ写真が別のかたちに入っても、決めた隠し方を引き継ぐ。写真の出す・出さない（photo_choice）とは別の表
--   - 見つけた顔も手で描いた枠も「隠す」（shown = 0）で始まる。変換ページで顔ごとに「出す」へ切り替えられる
--   - photo_face_scan に行がある＝顔の検出が済んでいる（顔が 0 件でも行を持つ）。
--     行の無い写真を日記に出そうとすると、書き出しを止める（素顔のまま外へ出さない）
CREATE TABLE IF NOT EXISTS photo_face (
  photo_key   TEXT NOT NULL,                                       -- 例: kakera/2026/10/12_1432_<ULID>_1.jpg
  face_id     TEXT NOT NULL,                                       -- 写真の中での id（自動は a…・手で足した枠は m…）
  x           REAL NOT NULL,                                       -- 写真に対する 0〜1 の比率（左上）
  y           REAL NOT NULL,
  w           REAL NOT NULL,                                       -- 写真に対する 0〜1 の比率（大きさ）
  h           REAL NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  shown       INTEGER NOT NULL DEFAULT 0 CHECK (shown IN (0, 1)),  -- 0 = 隠す・1 = 出す
  updated_at  TEXT NOT NULL,                                       -- ISO8601(JST)
  PRIMARY KEY (photo_key, face_id)
);

CREATE TABLE IF NOT EXISTS photo_face_scan (
  photo_key   TEXT PRIMARY KEY,
  model       TEXT NOT NULL,                                       -- 検出に使ったモデル（lib/publish/photo-face.ts の FACE_MODEL）
  scanned_at  TEXT NOT NULL                                        -- ISO8601(JST)
);
