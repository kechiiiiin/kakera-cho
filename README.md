# かけら帳

日記を「**かけら → かたち → 日記**」の三段で作る。

| 語 | 意味 |
|---|---|
| かけら | 書いた瞬間の一言。日付に属さない。書いた日時だけを持つ |
| かたち | かけらを選んで日付と題を決めて束ねたもの。**非公開** |
| 日記 | かたちから選んで世に出したもの。astro-blog の `.md` |

設計は vault の [[かけら帳設計]] / [[かけら帳設計・詳細]]（`hestia/projects/blog-cms-design/`）。
**ここに書いていないことは決まっていない。**

- 実装: Astro SSR / Cloudflare Workers / Preact / zod / octokit / jose
- 原本の真実: **D1**（`kakera` / `katachi` / `katachi_kakera`（置き場所） / `nikki` / `nikki_kakera`（書き出しの記録） / `device`）
- 原本の控え: **`kakera-data`（private）** に Markdown（保存の都度・`waitUntil` で裏に回す）
- 公開先: **`astro-blog`** の `src/content/diary/YYYY-MM-DD.md` へ octokit で直接 commit
- 写真: 非公開バケット **`kakera-photos`**。日記に出すときだけ公開バケット `images` へコピー
- 公開ドメイン: `kakera.kechiiiiin.com`（Cloudflare Access で保護・`workers.dev` は生やさない）

⚠️ **このリポジトリと astro-blog は public。** 原本（かけら・かたち）を置いてはいけない。
原本は D1 と `kakera-data`（private）にだけ置く。

---

## 初期構築（2026-09-12 に済み・記録）

作り直すときのための記録。いまは全部済んでいる。

1. GitHub の細粒度 PAT を2本（`kechiiiiin/astro-blog` 用・`kechiiiiin/kakera-data` 用、どちらも Contents: Read and write）
2. 一度 `npx wrangler deploy` して Worker を作る（`secret put` の置き場ができる）
3. `npx wrangler secret put` で `BLOG_GITHUB_TOKEN` / `DATA_GITHUB_TOKEN` / `ALLOWED_EMAILS` / `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`
4. Cloudflare Access の Self-hosted アプリを `kakera.kechiiiiin.com` に（Google ログイン・メール allowlist）
5. Custom Domain `kakera.kechiiiiin.com`（いまは `wrangler.toml` の `[[routes]]` にあり、deploy だけで揃う）

⚠️ `/api/*` を Access の Bypass にしない（ブラウザからの API に JWT が付かなくなり全部 401）。Bypass が要るのは iOS を足すとき。

---

## 手元で動かす

```sh
npm install
npm run db:local      # ローカル D1 に初期スキーマを流す（初回だけ）
# 続けて migrations/0001〜0008 を番号順に当てる（package.json の db:migrate:*:local）
cp .dev.vars.example .dev.vars   # 値は空のままでよい（DEV_BYPASS_AUTH=1 だけ効く）
npm run dev
```

`.dev.vars` に `DEV_BYPASS_AUTH=1` があるときだけ認証を迂回する。

**本番で効かないことの保証**（`src/middleware.ts`）:

1. `import.meta.env.DEV` はビルド時に `false` へ静的置換されるので、本番バンドルでは
   `devBypassAllowed()` が丸ごと `return false;` に潰れる（`dist/_worker.js/` を見れば確認できる）
2. それでも、ホスト名が `localhost` / `127.0.0.1` のときしか通さない

トークンが無いので、ローカルでは **kakera-data への控えと astro-blog への書き出しは動かない**
（`BLOG_GITHUB_TOKEN が設定されていません` と返る）。D1 と R2 の流れは全部動く。

```sh
npm run check         # 型チェック（astro check）
npx tsc --noEmit -p . # ⚠️ astro check は API の import 忘れを見逃す。こちらも必ず通す
npm run build         # 本番ビルド
# 本番 D1: 初期スキーマと 0001〜0008 は適用済み。新しいマイグレーションはデプロイより先に当てる
```

---

## 覚えておくこと（踏むと痛い罠）

- **`written_at` は必ず `+09:00` 付き**。控えのファイル名 `DD_hhmm` がこれから決まるので、
  オフセットが揺れると削除時にどのファイルを消すか分からなくなる
- **`pubDate` は JST の日付のみ**。時刻を入れると UTC 由来のズレを踏む（blog-cms で実際に起きた）
- **区切り線の前後には本物の空行**。無いと `---` が setext 見出しに化けて、上の段落ごと見出しになる
  （`src/lib/markdown.ts` の `ensureHrBlankLines` が保証する）
- **`nikki` に行が無い日付のファイルには書かない**（`src/lib/publish/astro-blog.ts` の安全弁）。
  既存の日記 233 件のうち 219 件は microCMS 移行分の `format: html` で、Markdown で上書きすると壊れる
- **かたちの日付を変えたら控えを改名する**（旧ファイルを消す）。blog-cms の「古いファイルが残る」罠
- **未来日で日記にすると X には投稿されない**（`post-diary-to-x.mjs` が弾き、その後も遡らない）
- **日記は毎回まるごと組み直す**。日記側で手直ししたものは次の書き出しで消える。直すのは原本の側で
- GitHub へ書くときは**必ず sha を取ってから**（`src/lib/backup/github.ts` の `putFile`）

## 構成

```
src/
  middleware.ts              Access JWT の検証（jose・fail-closed）
  pages/
    index.astro              画面の入口（Preact を client:load で載せる）
    api/                     設計 §7 の API 一式
  lib/
    kakera/db.ts             D1 への問い合わせ（ドメインの処理の入口）
    backup/                  kakera-data への控え（github.ts / kakera-data.ts / sync.ts）
    publish/                 astro-blog への公開（astro-blog.ts / photos.ts）
    markdown.ts              区切り線の正規化・画像記法の出し入れ
    time.ts  ulid.ts  http.ts  ctx.ts
  components/                画面（Preact）。API を叩くだけの薄い層
schema.sql                   設計 §3 の DDL
wrangler.toml                バインディングと [vars]
```

## まだ作っていないもの（第二段）

かたちの全文検索（FTS5・trigram）／iOS ネイティブ（同じ API・共有シート・ウィジェット・オフライン）／
端末トークンの発行画面。`device` テーブルと `POST /api/device` は先に用意してあるが、
**Bearer での認証経路そのものは第二段**（Access と素直には両立しないため）。
