-- 日記の説明文（astro-blog の frontmatter `description` → og:description / twitter:description）。2026-09-13。
-- 適用: npm run db:migrate:description:local / npm run db:migrate:description:remote
-- ⚠️ 一度だけ当てる（ALTER TABLE ADD COLUMN は再適用すると「もうある列」で止まる。CREATE TABLE は IF NOT EXISTS）。
-- ⚠️ DDL だけ。中身（説明の文字・選択）は画面から入る。既存の行の値は既定の '' になるだけ。
--
-- なぜ:
--   書き出しが description を書いていなかったので、X のカードにサイト既定の紹介文が出ていた。
--   説明は「日記にする」画面で書き、公開名変換（名前の置き換え）を当ててから frontmatter に書く。
--
-- 決まり:
--   - 説明の原本は katachi.description（実名のまま・改行は空白に畳んで保存）。空なら frontmatter に description を書かない
--   - 置き場所を katachi にしたのは、「日記にする」画面で書く時点ではまだ nikki の行が無い（初めて書き出す前）ため。
--     1かたち＝1日記なので、かたちの列で1対1に持てる。控え（kakera-data の katachi/*.md）にも載る
--   - タイトルと違い、書き足すたびに消えないよう保存する（次に「日記に書き足す」を開いたときも入っている）
--   - ★katachi.updated_at は進めない（日付か題が変わったときだけ進む、の意味を崩さない）
--   - 説明への公開名変換の選択は description_name_choice に持つ。name_choice の scope は CHECK で
--     ('kakera','title') に縛られていて、足すには表の作り直し（データの写し）が要るので、別の表に分けた
--   - 選択の basis は保存したときの説明の文字列。違えば説明の選択は白紙（タイトルと同じ流儀）
--   - 選択は置き換え元（実名）を含むので D1 にだけ置く

ALTER TABLE katachi ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- 説明の箇所ごとの選択（承認＝辞書どおりは行を持たない。手で直した・拒否だけを残す）。
-- pos は原本の説明（katachi.description・畳んだ後）の中の位置（UTF-16 の添字）。
-- 辞書の語を直した・消したときは、name_choice と同じくその語の行を消す（names/db.ts）。
CREATE TABLE IF NOT EXISTS description_name_choice (
  katachi_id  TEXT NOT NULL REFERENCES katachi(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,
  source      TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('approve', 'edit', 'reject')),
  text        TEXT,               -- action = 'edit' のときの言葉
  basis       TEXT NOT NULL,      -- 保存したときの説明の文字列
  updated_at  TEXT NOT NULL,      -- ISO8601(JST)
  PRIMARY KEY (katachi_id, pos)
);
