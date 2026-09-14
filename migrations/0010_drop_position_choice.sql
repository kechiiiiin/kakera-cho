-- 位置方式の古い表を捨てる（公開名変換設計・記号方式の移行とテスト §3）。
-- 適用: npm run db:migrate:drop-position-choice:local / npm run db:migrate:drop-position-choice:remote
--
-- ⚠️⚠️ 当てるのは、0009 と記号方式のコードが本番で数日動いたのを確かめてから。
--    当てる直前に三つの表が 0 件か数え直す（0 でなければ止めて相談）。
--    戻すときは 0003 の name_choice・0007 の description_name_choice・0008 の publish_body の CREATE 文だけを流し直す
--    （0007 の ALTER TABLE katachi ADD COLUMN は流さない）。
-- 新しいコードはこの三つの表を読まない・書かない。

DROP TABLE IF EXISTS name_choice;
DROP TABLE IF EXISTS description_name_choice;
DROP TABLE IF EXISTS publish_body;
