-- かけら帳の初期スキーマ（設計「かけら帳設計・詳細」§3 のまま）
-- 適用: npm run db:local / npm run db:remote
-- ⚠️ これは「初期」の形。新しく立てる環境では、このあと migrations/0001〜0004 を順に流して最終形にする。
--    特に 0004 で kakera.katachi_id / sort_order は落ち、置き場所は katachi_kakera に移る。

-- かけら
CREATE TABLE IF NOT EXISTS kakera (
  id          TEXT PRIMARY KEY,   -- ULID。端末で採番（オフラインでも作れる）
  body        TEXT NOT NULL,      -- Markdown。写真は ![](url) で本文中に
  written_at  TEXT NOT NULL,      -- ISO8601(JST)。書いた日時。★不変（書き換えない）
  katachi_id  TEXT,               -- NULL = まだかたちになっていない
  sort_order  REAL,               -- かたちの中での並び（小数で間に挿せる）
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kakera_nagare  ON kakera(katachi_id, written_at DESC);
CREATE INDEX IF NOT EXISTS idx_kakera_katachi ON kakera(katachi_id, sort_order);

-- かたち
CREATE TABLE IF NOT EXISTS katachi (
  id         TEXT PRIMARY KEY,    -- ULID
  date       TEXT NOT NULL,       -- 'YYYY-MM-DD'（日記の日付）
  title      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_katachi_date ON katachi(date);   -- ★1日1かたち

-- 日記そのもの（1つのかたちにつき1行）
CREATE TABLE IF NOT EXISTS nikki (
  katachi_id   TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,     -- 'YYYY-MM-DD'（astro-blog のファイル名）
  published_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL      -- 書き足した日時
);

-- 日記に出したかけら（1行＝かけら1枚）
CREATE TABLE IF NOT EXISTS nikki_kakera (
  katachi_id TEXT NOT NULL,
  kakera_id  TEXT NOT NULL,
  position   INTEGER NOT NULL,    -- 公開版での並び
  PRIMARY KEY (katachi_id, kakera_id)
);

-- 端末（iOS 用の長期トークン。第二段で使うが表は最初から作る）
CREATE TABLE IF NOT EXISTS device (
  id           TEXT PRIMARY KEY,  -- ULID
  name         TEXT NOT NULL,     -- 'iPhone'
  token_hash   TEXT NOT NULL,     -- SHA-256 の16進。★平文は保存しない
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_token ON device(token_hash);
