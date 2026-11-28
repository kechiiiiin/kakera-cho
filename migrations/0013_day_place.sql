-- 1日のページ（かけら帳1日のページ設計・段階1・2026-11-28）: 気分・場所・一覧から外した予定と写真。
-- 適用: npm run db:migrate:day-place:local / npm run db:migrate:day-place:remote
-- ⚠️ DDL だけ。IF NOT EXISTS なので再適用しても壊れない。既存の表（kakera など）には一切手を入れていない。
--    既存のかけらは written_at で日が決まるので、移すものは無い（そのまま一覧の1種類になる）。
--
-- 決まり:
--   - day: 1日1行。mood は 嬉・楽・穏・疲・哀 のどれかか NULL（外した）。ふり返りが欲しくなったらここに列を足す
--   - place: 行った場所。at は ISO8601（+09:00 付き）。at の先頭10文字がその日（JST）になる（kakera.written_at と同じ）。
--     手入力の名前は端末でジオコーディングして座標ごと保存する。取れなければ lat / lng は NULL（両方そろって NULL）
--   - timeline_hidden: 端末のカレンダーの予定・写真を一覧から外した印（本体は消さない）。ref は予定の id・写真の localIdentifier
--   - 控え（kakera-data）には day/YYYY-MM-DD.md として気分と場所を書く。timeline_hidden は見せ方なので載せない

CREATE TABLE IF NOT EXISTS day (
  date        TEXT PRIMARY KEY,                                                    -- 'YYYY-MM-DD'（JST）
  mood        TEXT CHECK (mood IS NULL OR mood IN ('嬉', '楽', '穏', '疲', '哀')),
  updated_at  TEXT NOT NULL                                                        -- ISO8601(JST)
);

CREATE TABLE IF NOT EXISTS place (
  id          TEXT PRIMARY KEY,                                                    -- ULID（端末で採番）
  at          TEXT NOT NULL,                                                       -- ISO8601（+09:00 付き）
  name        TEXT NOT NULL,
  lat         REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng         REAL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'visit')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_place_at ON place(at);

CREATE TABLE IF NOT EXISTS timeline_hidden (
  kind        TEXT NOT NULL CHECK (kind IN ('event', 'photo')),
  ref         TEXT NOT NULL,
  date        TEXT NOT NULL,                                                       -- 'YYYY-MM-DD'（JST・その日の一覧から外した）
  created_at  TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_timeline_hidden_date ON timeline_hidden(date);
