// 日記にする＝astro-blog へ octokit で直接 commit する（blog-cms を経由しない）。設計 §5。
//
// 日記は「かたちから毎回まるごと組み直す」。書き足すときも差分追記ではなく、
// 選び直した内容でファイルを丸ごと上書きする。

import { composeBody, replacePhotoUrls } from '../markdown';
import { ApiError } from '../http';
import { fileExists, putText, type RepoRef } from '../backup/github';
import { copyPhotosForPublish } from './photos';
import { renderDiaryFile } from './diary-file';

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
   * 公開名変換を済ませた本文（出す順）。
   * ⚠️ 呼ぶ側が原本（D1 のかけら）から置き換え直したもの。画面から届いた本文を渡さない。
   */
  bodies: string[];
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
export async function publishNikki(env: Env, input: PublishInput): Promise<{ path: string }> {
  const ref = blogRepo(env);
  const path = diaryPath(input.date);

  if (!input.alreadyPublished && (await fileExists(ref, path))) {
    throw new ApiError(
      409,
      `${input.date} の日記は既に astro-blog にあります（かけら帳が作ったものではありません）。上書きすると過去の記事を壊すので書き出しません。`
    );
  }

  // 日記に出すときだけ、写真を公開バケットへコピーして公開版の URL を差し替える。
  // 原本（D1・控え）の本文は触らない。
  // 公開名変換は画像の URL を触らないので、置き換えた後の本文から写真を拾ってよい。
  const urlMap = await copyPhotosForPublish(env, input.bodies);
  const bodies = input.bodies.map((b) => (urlMap.size ? replacePhotoUrls(b, urlMap) : b));

  const content = renderDiaryFile(input.title, input.date, composeBody(bodies));
  const verb = input.alreadyPublished ? 'update' : 'create';
  await putText(ref, path, content, `${verb}(diary): ${input.title || input.date}`);
  return { path };
}
