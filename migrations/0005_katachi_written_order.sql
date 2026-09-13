-- かたちの中の並びを「常に書いた順」にし、手で並べる列を落とす（2026-09-13）。
-- 適用: npm run db:migrate:written-order:local / npm run db:migrate:written-order:remote
-- ⚠️ 0004 を当てた後に一度だけ当てる（再適用すると、もう無い索引・列で止まる）。
--
-- なぜ:
--   「かたちにする」ではかけらたちが新しい順に並び、選んだ順がそのまま並びになっていたので、
--   上から素直に選ぶと時系列が逆さまのかたちになった。
--   かたちは書いた順の事実の束でよく、並びを調整したくなるのは日記のほう——
--   日記の並びは nikki_kakera.position が持つので、かたちの側に並びの列は要らない。
--
-- 決まり:
--   - かたちの中の並びは kakera.written_at の古い順（同時刻は kakera.id 順）。db.ts が ORDER BY で決める
--   - 所属（katachi_id, kakera_id）はそのまま残る。落とすのは sort_order だけ
--   - kakera・katachi・nikki・nikki_kakera には触らない（時刻は進まない）
--
-- 当てる前後で所属の件数が変わらないこと（同じ値になること）:
--   SELECT count(*) FROM katachi_kakera;

-- sort_order を含む索引は列を落とす前に消す（SQLite は索引に使われている列を DROP COLUMN できない）
DROP INDEX IF EXISTS idx_katachi_kakera_order;
ALTER TABLE katachi_kakera DROP COLUMN sort_order;

-- かたちの中身を引く索引。主キー (katachi_id, kakera_id) も katachi_id で引けるが、意図を名前で残す
CREATE INDEX idx_katachi_kakera_katachi ON katachi_kakera(katachi_id);
