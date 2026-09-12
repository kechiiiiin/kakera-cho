// GitHub Contents API の薄いラッパ。控え（kakera-data）と公開（astro-blog）の両方が使う。
//
// ⚠️ 書くときは必ず「読んで sha を得てから」。
// 「かけらは新規追加だけだから衝突しない」は作成時だけ真で、本文の修正・削除・かたちへの出入りでは
// 既存ファイルを触る（設計 §4）。

import { Octokit } from 'octokit';

export interface RepoRef {
  owner: string;
  repo: string;
  token: string;
  branch?: string;
}

function client(ref: RepoRef): Octokit {
  return new Octokit({ auth: ref.token });
}

function statusOf(e: unknown): number | undefined {
  if (typeof e === 'object' && e !== null && 'status' in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/** Workers には Buffer が無い。UTF-8 を base64 にする。 */
export function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Uint8Array（写真など）を base64 に。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export interface ExistingFile {
  sha: string;
  text: string;
}

/** 無ければ null（404 を「新規」と読み替える）。 */
export async function readFile(ref: RepoRef, path: string): Promise<ExistingFile | null> {
  try {
    const res = await client(ref).rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: ref.branch ?? 'main',
    });
    const data = res.data as { type?: string; sha?: string; content?: string };
    if (data.type !== 'file' || typeof data.sha !== 'string') return null;
    return { sha: data.sha, text: data.content ? decodeBase64(data.content) : '' };
  } catch (e) {
    if (statusOf(e) === 404) return null;
    throw e;
  }
}

/** 存在するかだけを見る（本文を落とさない）。 */
export async function fileExists(ref: RepoRef, path: string): Promise<boolean> {
  return (await readFile(ref, path)) !== null;
}

/** 読んで sha を取ってから書く upsert。 */
export async function putFile(
  ref: RepoRef,
  path: string,
  contentBase64: string,
  message: string
): Promise<void> {
  const existing = await readFile(ref, path);
  await client(ref).rest.repos.createOrUpdateFileContents({
    owner: ref.owner,
    repo: ref.repo,
    path,
    message,
    content: contentBase64,
    branch: ref.branch ?? 'main',
    ...(existing ? { sha: existing.sha } : {}),
  });
}

export async function putText(ref: RepoRef, path: string, text: string, message: string): Promise<void> {
  await putFile(ref, path, encodeBase64(text), message);
}

/** 無ければ黙って何もしない（控えの掃除で使うので、片付け済みを失敗にしない）。 */
export async function deleteFile(ref: RepoRef, path: string, message: string): Promise<void> {
  const existing = await readFile(ref, path);
  if (!existing) return;
  await client(ref).rest.repos.deleteFile({
    owner: ref.owner,
    repo: ref.repo,
    path,
    message,
    sha: existing.sha,
    branch: ref.branch ?? 'main',
  });
}
