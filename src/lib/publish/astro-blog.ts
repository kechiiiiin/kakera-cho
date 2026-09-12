// 日記にする＝astro-blog へ octokit で直接 commit する（blog-cms を経由しない）。設計 §5。
//
// 日記は「かたちから毎回まるごと組み直す」。書き足すときも差分追記ではなく、
// 選び直した内容でファイルを丸ごと上書きする。

import type { Kakera } from '../kakera/types';
import { composeBody, replacePhotoUrls } from '../markdown';
import { ApiError } from '../http';
import { fileExists, putText, type RepoRef } from '../backup/github';
import { copyPhotosForPublish } from './photos';

export function blogRepo(env: Env): RepoRef {
  if (!env.BLOG_GITHUB_TOKEN) throw new ApiError(503, 'BLOG_GITHUB_TOKEN が設定されていません');
  return { owner: env.GITHUB_OWNER, repo: env.BLOG_REPO, token: env.BLOG_GITHUB_TOKEN };
}

export function diaryPath(date: string): string {
  return `src/content/diary/${date}.md`;
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * astro-blog の zod（src/content/config.ts）に合わせた frontmatter。
 * description / heroImage / format は書かない（format の既定は md）。
 * ⚠️ pubDate は JST の日付のみ。時刻を入れると UTC 由来のズレを踏む（設計 §11）。
 */
export function renderDiaryFile(title: string, date: string, body: string): string {
  return [
    '---',
    `title: ${yamlString(title || date)}`,
    `pubDate: ${date}`,
    'tags: []',
    'draft: false',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export interface PublishInput {
  date: string;
  title: string;
  kakera: Kakera[];
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
  const urlMap = await copyPhotosForPublish(env, input.kakera.map((k) => k.body));
  const bodies = input.kakera.map((k) => (urlMap.size ? replacePhotoUrls(k.body, urlMap) : k.body));

  const content = renderDiaryFile(input.title, input.date, composeBody(bodies));
  const verb = input.alreadyPublished ? 'update' : 'create';
  await putText(ref, path, content, `${verb}(diary): ${input.title || input.date}`);
  return { path };
}
