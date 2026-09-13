-- 日記にだけ効く文章の微修正（公開名変換設計「日記にだけ効く文章の微修正を作る」）。2026-09-13。
-- 適用: npm run db:migrate:publish-body:local / npm run db:migrate:publish-body:remote
-- ⚠️ DDL だけ。IF NOT EXISTS なので再適用しても壊れない。既存の表には一切手を入れていない。
-- ⚠️ 中身（書き換えた文章）は実名を含みうるので D1 にだけ置く。控え（kakera-data）にもリポジトリにも書かない。
--
-- 決まり:
--   - かけら一枚ごとに「日記に出す本文」をまるごと持つ（箇所ごとではない＝原本を直しても位置ずれで壊れない）
--   - 行が無いかけらは原本（kakera.body）をそのまま使う。原本（kakera の行）はここから一切書き換えない
--   - 書き出し・変換ページの名前の置き換え・写真の出す／出さないは、行があればこの body に当てる（サーバで当て直す）
--   - basis = 書き換えを保存した（または「書き換えを使う」を選んだ）時点の kakera.updated_at。
--     今の kakera.updated_at と違えば「原本が変わっています」と知らせる。黙って消さない（選ぶまでは書き換えを使う）
--   - updated_at = 書き換えた文章を保存した時刻（「書き換えを使う」では進めない）
--   - かたちを消す・かけらを消すと ON DELETE CASCADE で消える。かたちから外しただけでは残る
CREATE TABLE IF NOT EXISTS publish_body (
  katachi_id  TEXT NOT NULL REFERENCES katachi(id) ON DELETE CASCADE,
  kakera_id   TEXT NOT NULL REFERENCES kakera(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,      -- 日記に出す本文（名前は置き換える前の実名のまま）
  basis       TEXT NOT NULL,      -- 書き換えた時点の kakera.updated_at
  updated_at  TEXT NOT NULL,      -- ISO8601(JST)
  PRIMARY KEY (katachi_id, kakera_id)
);
