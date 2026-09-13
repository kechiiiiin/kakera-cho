-- 写真ごとの「日記に出す／出さない」（公開名変換設計「追加決定（2026-09-13）: 変換ページで写真も選ぶ」）。
-- 適用: npm run db:migrate:photo-choice:local / npm run db:migrate:photo-choice:remote
-- ⚠️ DDL だけ。IF NOT EXISTS なので再適用しても壊れない。既存の表には一切手を入れていない。
--
-- 決まり:
--   - 「出す」は行を持たない（開いた時点では全部出す）。行があるのは「出さない」写真だけ
--   - 本文中の位置ではなく写真の key（kakera-photos の key）に紐づける。
--     かけらの文章を直しても白紙に戻らない。写真を本文から消せば、その行は効かなくなる（読むときに原本と突き合わせる）
--   - 書き出しでは、届いた選択のうち「そのかけらの原本に実在する写真の key」だけを当てる
CREATE TABLE IF NOT EXISTS photo_choice (
  kakera_id   TEXT NOT NULL,
  photo_key   TEXT NOT NULL,                              -- 例: kakera/2026/09/xxxx.jpg
  hidden      INTEGER NOT NULL DEFAULT 1 CHECK (hidden = 1), -- 出さない印（出す写真は行を持たない）
  updated_at  TEXT NOT NULL,                              -- ISO8601(JST)
  PRIMARY KEY (kakera_id, photo_key)
);
