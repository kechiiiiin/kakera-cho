-- かけらごとに時刻を出す（かけら時刻表示設計・2026-10-12）。
-- 適用: npm run db:migrate:show-time:local / npm run db:migrate:show-time:remote
-- ⚠️ 一度だけ当てる（ALTER TABLE ADD COLUMN は再適用すると「もうある列」で止まる）。
-- ⚠️ 0011 は別の作業（顔モザイク）が使っているので、番号を一つ飛ばしている。当てる順はどちらが先でもよい。
--
-- 決まり:
--   - 「時刻を出す」のチェックは、かたちの中での見せ方なので、かけら本体（kakera）ではなく置き場所（katachi_kakera）に持つ。
--     かけらをかたちから外せば、行ごと一緒に消える（入れ直したら既定のオフに戻る）
--   - 既定はオフ（0）。既存のかたちは見た目も書き出し結果も変わらない
--   - 出す時刻は kakera.written_at から作る（日時を直したら表示もそれに従う）。この列は「出すか」だけを持つ
--   - ★チェックを変えても kakera.updated_at・katachi.updated_at は進めない（公開名変換の basis を崩さない）
--   - 公開中の日記は即座に書き直さない。次に書き出したときに反映する
--   - 控え（kakera-data）には載せない

ALTER TABLE katachi_kakera ADD COLUMN show_time INTEGER NOT NULL DEFAULT 0 CHECK (show_time IN (0, 1));
