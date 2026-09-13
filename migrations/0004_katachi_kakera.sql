-- かけらの「置き場所」を中間テーブルへ出す（2026-09-13）。
-- 適用: npm run db:migrate:katachi-kakera:local / npm run db:migrate:katachi-kakera:remote
-- ⚠️ 一度だけ当てる（再適用すると、もう無い kakera.katachi_id を読もうとして止まる）。
--
-- なぜ:
--   kakera に「中身（body / updated_at）」と「置き場所（katachi_id / sort_order）」が同居していたため、
--   かたちに入れる・並べ替える・外す・解くだけで kakera.updated_at が進み、
--   公開名変換の選択（name_choice.basis = 保存時の kakera.updated_at）が本文を直していないのに白紙に戻っていた。
--   置き場所は katachi_kakera だけが持ち、kakera.updated_at は本文を直したときだけ進める。
--
-- 決まり:
--   - 一つのかけらは一つのかたちにしか入らない → kakera_id に UNIQUE
--   - 流れ（未かたち）＝ katachi_kakera に行が無いかけら
--   - かたち・かけらを消せば、置き場所の行は ON DELETE CASCADE で消える（D1 は外部キーを既定で強制する）
--   - nikki_kakera は「書き出したときの記録」なので、ここでは触らない（kakera への外部キーも張らない）
--
-- 当てる前の確認（どちらも 0 件であること。0 件でなければ INSERT が外部キー／NOT NULL で止まる）:
--   SELECT count(*) FROM kakera WHERE katachi_id IS NOT NULL AND katachi_id NOT IN (SELECT id FROM katachi);
--   SELECT count(*) FROM kakera WHERE katachi_id IS NOT NULL AND sort_order IS NULL;
--
-- FTS のトリガ（kakera_fts_ai / _au(AFTER UPDATE OF body) / _ad）は id と body しか参照しないので、
-- 列を落としてもそのまま動く（ローカルで INSERT・UPDATE・DELETE を確認済み）。

CREATE TABLE katachi_kakera (
  katachi_id  TEXT NOT NULL REFERENCES katachi(id) ON DELETE CASCADE,
  kakera_id   TEXT NOT NULL UNIQUE REFERENCES kakera(id) ON DELETE CASCADE,
  sort_order  REAL NOT NULL,      -- かたちの中での並び（小数で間に挿せる）
  PRIMARY KEY (katachi_id, kakera_id)
);
CREATE INDEX idx_katachi_kakera_order ON katachi_kakera(katachi_id, sort_order);

-- 既存の所属と並び順を写す（kakera.updated_at は触らない＝保存済みの公開名変換の選択はそのまま効く）
INSERT INTO katachi_kakera (katachi_id, kakera_id, sort_order)
SELECT katachi_id, id, sort_order FROM kakera WHERE katachi_id IS NOT NULL;

-- 古い置き場所の列と、それを含む索引を落とす
DROP INDEX IF EXISTS idx_kakera_nagare;
DROP INDEX IF EXISTS idx_kakera_katachi;
ALTER TABLE kakera DROP COLUMN katachi_id;
ALTER TABLE kakera DROP COLUMN sort_order;

-- 流れは「新しい順」で引く
CREATE INDEX idx_kakera_written ON kakera(written_at DESC);
