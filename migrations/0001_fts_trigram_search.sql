-- 第二段: かたちの全文検索（設計「かけら帳設計・詳細」§3）。
-- 適用: npm run db:migrate:local / npm run db:migrate:remote
-- ⚠️ schema.sql には追記しない（適用済みスキーマを再実行させないため、独立ファイルにしてある）。
-- ⚠️ 既存の kakera / katachi / nikki / nikki_kakera / device の DDL には一切手を入れていない。

-- kakera(body) への外付け索引。トークナイザは trigram（日本語は unicode61 では語に切れないため）。
-- D1 が trigram を受け付けることは local / remote 両方で実機確認済み（2026-09-12）。
--
-- FTS テーブルは kakera_id と body だけを持ち、katachi_id は同期しない。
-- 「かたちに属さないかけら（流れ）は検索対象に含めない」は設計どおりだが、索引自体は kakera 全体
-- （流れも含む）を対象にし、絞り込みは検索クエリ側で
--   JOIN kakera ON kakera.id = kakera_fts.kakera_id WHERE kakera.katachi_id IS NOT NULL
-- として行う（後から流れも検索できるようにするため）。katachi_id は出し入れのたびに変わるが、
-- ここを同期対象から外しておけば、その変更のたびに FTS を触る必要がなくなる。
CREATE VIRTUAL TABLE IF NOT EXISTS kakera_fts USING fts5(
  kakera_id UNINDEXED,
  body,
  tokenize = 'trigram'
);

-- 同期はトリガで行う（アプリ側同期ではなくこちらを選んだ）。
--
-- 理由: kakera への書き込みは src/lib/kakera/db.ts の複数の関数
-- （insertKakera / updateKakeraBody / deleteKakera）を経由し、かたちの組み替え
-- （createKatachi / updateKatachi / dissolveKatachi / detachKakera）も kakera 行を UPDATE する。
-- 書き込み経路が今後増えたときに「FTS への同期をどこかで書き忘れる」ことが起こり得るが、
-- トリガであれば kakera への書き込みがどの関数を通っても自動的に一貫性が保たれる。
-- D1 (SQLite) 上で通常テーブルへの書き込みをトリガ経由で FTS5 仮想テーブルへ反映できることは
-- local / remote 両方で INSERT・UPDATE・DELETE すべて実機確認済み（2026-09-12）。
--
-- 更新は「AFTER UPDATE OF body」にしてあるので、body を触らない UPDATE
-- （createKatachi / updateKatachi の並び替え・dissolveKatachi・detachKakera が行う
-- katachi_id / sort_order だけの更新）では発火しない。検索は body の中身しか見ないので、
-- そのぶんの無駄な再索引をしない意図的な選択。
CREATE TRIGGER IF NOT EXISTS kakera_fts_ai AFTER INSERT ON kakera BEGIN
  INSERT INTO kakera_fts (kakera_id, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS kakera_fts_au AFTER UPDATE OF body ON kakera BEGIN
  DELETE FROM kakera_fts WHERE kakera_id = old.id;
  INSERT INTO kakera_fts (kakera_id, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS kakera_fts_ad AFTER DELETE ON kakera BEGIN
  DELETE FROM kakera_fts WHERE kakera_id = old.id;
END;

-- 既存のかけらのバックフィル。まだ索引に無いものだけを入れるので、再適用しても重複しない
-- （FTS5 の UNINDEXED 列には一意制約が無く「INSERT OR IGNORE」では重複を防げないため、
--  NOT IN で確認してから入れる）。
INSERT INTO kakera_fts (kakera_id, body)
SELECT id, body FROM kakera
WHERE id NOT IN (SELECT kakera_id FROM kakera_fts);
