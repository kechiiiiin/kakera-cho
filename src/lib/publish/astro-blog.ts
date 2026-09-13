// 日記にする＝astro-blog へ octokit で直接 commit する（blog-cms を経由しない）。設計 §5。
//
// 日記は「かたちから毎回まるごと組み直す」。書き足すときも差分追記ではなく、
// 選び直した内容でファイルを丸ごと上書きする。

import { composeBody, replacePhotoUrls } from '../markdown';
import { ApiError } from '../http';
import { fileExists, putText, readFile, type RepoRef } from '../backup/github';
import { getLinkCardRows } from '../kakera/db';
import { blogCardKeysOf } from '../card/url';
import { copyPhotosForPublish } from './photos';
import { renderDiaryFile } from './diary-file';
import { LINK_CARDS_PATH, LinkCardsJsonError, buildCardEntries, mergeCardsJson } from './link-cards';

/** astro-blog への読み書き（github.ts の upsert）。書き出しの順番を差し替えて確かめられるよう一つにまとめてある。 */
export interface BlogWriter {
  fileExists: typeof fileExists;
  readFile: typeof readFile;
  putText: typeof putText;
}

const githubWriter: BlogWriter = { fileExists, readFile, putText };

export function blogRepo(env: Env): RepoRef {
  if (!env.BLOG_GITHUB_TOKEN) throw new ApiError(503, 'BLOG_GITHUB_TOKEN が設定されていません');
  return { owner: env.GITHUB_OWNER, repo: env.BLOG_REPO, token: env.BLOG_GITHUB_TOKEN };
}

export function diaryPath(date: string): string {
  return `src/content/diary/${date}.md`;
}

export { renderDiaryFile };

export interface PublishInput {
  date: string;
  /** 公開名変換を済ませたタイトル（X にも出る・commit メッセージにも入る） */
  title: string;
  /**
   * 公開名変換を済ませた説明文（og:description / X のカードに出る）。空なら frontmatter に書かない。
   * ⚠️ 呼ぶ側が D1 に保存した説明から置き換え直したもの。
   */
  description?: string;
  /**
   * 公開名変換を済ませた本文（出す順）。
   * ⚠️ 呼ぶ側が原本（D1 のかけら）から置き換え直したもの。画面から届いた本文を渡さない。
   */
  bodies: string[];
  /**
   * 日記に出さない写真の key（全かけらぶん）。bodies からは既に除いてあるが、
   * 除き漏れがあっても公開バケットへはコピーしない（二重の備え）。
   */
  hiddenPhotoKeys?: ReadonlySet<string>;
  /** その日付のかたちが既に日記になっているか（nikki に行があるか） */
  alreadyPublished: boolean;
}

/**
 * 日記を書き出す。
 *
 * ⚠️ 安全弁（絶対に省略しない）:
 * 上書きしてよいのは、かけら帳が作った日記だけ。nikki に行が無いのに astro-blog に
 * 同じ日付のファイルがあるときは 409 で拒否する。既存の日記 233 件のうち 219 件は
 * microCMS 移行分の `format: html` で、Markdown で上書きすると過去の記事を壊す（設計 §5）。
 */
export async function publishNikki(
  env: Env,
  input: PublishInput,
  gh: BlogWriter = githubWriter
): Promise<{ path: string }> {
  const ref = blogRepo(env);
  const path = diaryPath(input.date);

  if (!input.alreadyPublished && (await gh.fileExists(ref, path))) {
    throw new ApiError(
      409,
      `${input.date} の日記は既に astro-blog にあります（かけら帳が作ったものではありません）。上書きすると過去の記事を壊すので書き出しません。`
    );
  }

  // 日記に出すときだけ、写真を公開バケットへコピーして公開版の URL を差し替える。
  // 原本（D1・控え）の本文は触らない。
  // 公開名変換は画像の URL を触らないので、置き換えた後の本文から写真を拾ってよい。
  // 日記に出さない写真は、呼ぶ側が本文から除いてある＝ここでは拾われず、公開バケットへコピーされない。
  const urlMap = await copyPhotosForPublish(env, input.bodies, input.hiddenPhotoKeys);
  const bodies = input.bodies.map((b) => (urlMap.size ? replacePhotoUrls(b, urlMap) : b));

  const body = composeBody(bodies);

  // ⚠️ リンクカードの JSON を**日記の .md より先に** commit する（リンクカード設計 §6.3）。
  // 逆順だと、日記の commit で走るビルドに JSON がまだ無く、カードの無い日記が公開される時間ができる。
  // JSON を書けなかったら日記も書かずに止める。
  await publishLinkCards(env, ref, input.date, body, gh);

  const content = renderDiaryFile(input.title, input.date, body, input.description ?? '');
  const verb = input.alreadyPublished ? 'update' : 'create';
  await gh.putText(ref, path, content, `${verb}(diary): ${input.title || input.date}`);
  return { path };
}

/**
 * その日記に出るカードを astro-blog の link-cards.json に追記する（リンクカード設計 §5.2・§6）。
 *
 * - 拾うのは**書き出す本文（公開名変換の後・出さない写真を除いた後）**に、行として独立して出てくる普通のサイトの URL だけ。
 *   日記にしていないかけらの URL は、ここに来る本文に無いので載らない
 * - キャッシュ（D1 link_card）に status='ok' の行があるものだけ載せる。失敗記録は載せない
 * - カード画像は公開バケットへコピーし（`diary/cards/<hash>.<ext>`）、JSON の image にその公開 URL を入れる
 * - 既存の JSON を読んで足す（消さない・同じキーは上書き）。中身が変わらなければ commit しない
 */
async function publishLinkCards(env: Env, ref: RepoRef, date: string, body: string, gh: BlogWriter): Promise<void> {
  const keys = blogCardKeysOf(body);
  if (!keys.length) return;

  const fail = (why: string, e?: unknown): never => {
    console.error('[link-card] JSON', why, e instanceof Error ? e.message : (e ?? ''));
    throw new ApiError(
      502,
      `リンクカードの控え（astro-blog の ${LINK_CARDS_PATH}）を${why}。日記は書き出していません。少し置いてからもう一度書き出してください。`
    );
  };

  let rows;
  try {
    rows = await getLinkCardRows(env.DB, keys);
  } catch (e) {
    return fail('用意できませんでした（カードのキャッシュを読めません）', e);
  }
  const entries = await buildCardEntries(env, rows);
  if (!Object.keys(entries).length) return;

  let existing;
  try {
    existing = await gh.readFile(ref, LINK_CARDS_PATH);
  } catch (e) {
    return fail('読めませんでした', e);
  }

  let merged;
  try {
    merged = mergeCardsJson(existing ? existing.text : null, entries);
  } catch (e) {
    if (e instanceof LinkCardsJsonError) return fail(`読めませんでした（${e.message}）。消してしまわないよう書き換えていません`, e);
    throw e;
  }
  if (!merged.changed) return;

  try {
    await gh.putText(ref, LINK_CARDS_PATH, merged.text, `chore(cards): link cards for ${date}`);
  } catch (e) {
    return fail('書き込めませんでした', e);
  }
}
