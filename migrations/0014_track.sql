-- 移動の軌跡（かけら帳1日のページ設計「追加: 移動の軌跡」・2026-11-28）: 大きく動いたときの点と訪問の点。
-- 適用: npm run db:migrate:track:local / npm run db:migrate:track:remote
-- ⚠️ DDL だけ。IF NOT EXISTS なので再適用しても壊れない。既存の表には一切手を入れていない。
--
-- 決まり:
--   - id は端末で採番する ULID。同じ id は二度入れない（POST /api/track は重複を黙って飛ばす）
--   - at は ISO8601（+09:00 付き）。先頭10文字がその日（JST）になる（place.at と同じ）
--   - source: 'slc'（大きな位置の変化）・'visit'（訪問 CLVisit の到着点）
--   - accuracy は水平の精度（メートル）。取れなければ NULL
--   - 控え（kakera-data）と書き出し（/api/export）には載せない（自宅の座標が大量に乗るため）

CREATE TABLE IF NOT EXISTS track_point (
  id          TEXT PRIMARY KEY,                                                    -- ULID（端末で採番）
  at          TEXT NOT NULL,                                                       -- ISO8601（+09:00 付き）
  lat         REAL NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lng         REAL NOT NULL CHECK (lng >= -180 AND lng <= 180),
  accuracy    REAL CHECK (accuracy IS NULL OR accuracy >= 0),
  source      TEXT NOT NULL CHECK (source IN ('slc', 'visit')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_point_at ON track_point(at);
