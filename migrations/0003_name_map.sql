-- 公開名変換（設計「公開名変換設計」）。日記に書き出すときだけ、辞書で名前を置き換える。
-- 適用: npm run db:migrate:name-map:local / npm run db:migrate:name-map:remote
-- ⚠️ schema.sql には追記しない（0001・0002 と同じく独立ファイル。再適用しても壊れない IF NOT EXISTS だけで書く）。
-- ⚠️ 既存の表には一切手を入れていない。
--
-- ⚠️⚠️ ここには DDL だけを書く。辞書の中身（初期データ）は絶対に書かない。
-- このリポジトリは public なので、書いた瞬間に置き換え元の一覧を公開することになる。
-- 中身は `wrangler d1 execute --command` か、日記タブの「名前の辞書」から入れる。

-- 辞書。例外（置き換えない語）は「自分自身へ置き換える項目」（target = source）として同じ表に持つ。
CREATE TABLE IF NOT EXISTS name_map (
  id          TEXT PRIMARY KEY,   -- ULID
  source      TEXT NOT NULL,      -- 置き換え元
  target      TEXT NOT NULL,      -- 置き換え先（例外は source と同じ）
  updated_at  TEXT NOT NULL       -- ISO8601(JST)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_map_source ON name_map(source);

-- 箇所ごとの選択（承認＝辞書どおりは行を持たない。手で直した・拒否だけを残す）。
--   scope = 'kakera' … ref_id はかけらの id。basis は保存したときの kakera.updated_at（違えばそのかけらの選択は白紙）
--   scope = 'title'  … ref_id はかたちの id。basis は保存したときのタイトルの文字列（違えばタイトルの選択は白紙）
-- pos は原本（置き換える前）の中の位置（UTF-16 の添字）。位置と source が今の当たり箇所と一致するものだけ効く。
CREATE TABLE IF NOT EXISTS name_choice (
  scope       TEXT NOT NULL CHECK (scope IN ('kakera', 'title')),
  ref_id      TEXT NOT NULL,
  pos         INTEGER NOT NULL,
  source      TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('approve', 'edit', 'reject')),
  text        TEXT,               -- action = 'edit' のときの言葉
  basis       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scope, ref_id, pos)
);
