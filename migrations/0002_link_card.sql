-- リンクカードのキャッシュ（設計「リンクカード設計・詳細」§3.1）。
-- 適用: npm run db:migrate:link-card:local / npm run db:migrate:link-card:remote
-- ⚠️ schema.sql には追記しない（0001 と同じく独立ファイル。再適用しても壊れない IF NOT EXISTS だけで書く）。
-- ⚠️ 既存の表には一切手を入れていない。
--
-- キーは**正規化した URL**（本文に書かれた元の URL から、フラグメントとトラッキングのクエリを落としたもの）。
-- リダイレクトの行き先は final_url に別に持つ。ここを混ぜると次に同じ URL を貼ったときに引けない。
--
-- 取り直しの目安（列にはしない）:
--   ok     … 取り直さない
--   failed … 7日を過ぎたものだけ、次にその URL を含むかけらを保存したときに一度やり直す
--            （読む画面からは絶対に叩かない）
CREATE TABLE IF NOT EXISTS link_card (
  url          TEXT PRIMARY KEY,   -- 正規化済みの URL（本文に書かれたもの）
  status       TEXT NOT NULL,      -- 'ok' | 'failed'
  title        TEXT,               -- og:title → twitter:title → <title>
  description  TEXT,               -- og:description → twitter:description → meta[name=description]
  site_name    TEXT,               -- og:site_name（無ければ NULL。表示はホスト名で代用）
  final_url    TEXT,               -- リダイレクトの行き先
  image_key    TEXT,               -- R2 kakera-photos の key。画像が無ければ NULL
  error        TEXT,               -- 失敗の理由（人が読む用。'timeout' 'http 403' 'not html' …）
  fetched_at   TEXT NOT NULL,      -- ISO8601(JST)。最後に取りに行った時刻
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_card_fetched ON link_card(fetched_at);
