// 控え（kakera-data・private）への書き出し。設計 §4。
//
// 「CMS を乗り換えても記事は無傷」という blog-cms の思想を、いちばん失いたくない原本にも適用する。
// 保存を押した都度・waitUntil で裏に回す。途中で失敗しても、かたちのファイルは常に
// D1 の現在の中身で丸ごと書き直す（冪等）ので次の保存で追いつく。
//
// ファイルの並び:
//   kakera/2026/09/12_1432_01HX….md   ← かけら1枚＝1ファイル
//   katachi/2026-09-09.md              ← かたち（本文を丸ごと持つ）

import type { Kakera, Katachi } from '../kakera/types';
import { partsOfWrittenAt } from '../time';
import { deleteFile, putText, type RepoRef } from './github';

export function dataRepo(env: Env): RepoRef | null {
  if (!env.DATA_GITHUB_TOKEN) return null; // トークン未設定なら控えは黙って諦める（本体は動く）
  return { owner: env.GITHUB_OWNER, repo: env.DATA_REPO, token: env.DATA_GITHUB_TOKEN };
}

/** かけらのファイルのパス。written_at から計算する（★だから written_at は不変） */
export function kakeraPath(k: Pick<Kakera, 'id' | 'written_at'>): string {
  const p = partsOfWrittenAt(k.written_at);
  return `kakera/${p.year}/${p.month}/${p.day}_${p.hhmm}_${k.id}.md`;
}

export function katachiPath(date: string): string {
  return `katachi/${date}.md`;
}

function yamlString(s: string): string {
  // 控えは人が読むためのものなので、素直に引用符で囲う
  return JSON.stringify(s);
}

export function renderKakeraFile(k: Kakera): string {
  return ['---', `id: ${k.id}`, `written_at: ${k.written_at}`, '---', '', k.body, ''].join('\n');
}

/**
 * かたちのファイル。参照だけだと人が読めないので本文を丸ごと持たせる。
 * 各かけらの前に「id | 時刻 | 日記 #n / 非公開」のコメントを置く。
 */
export function renderKatachiFile(
  katachi: Katachi,
  kakera: Kakera[],
  publishedIds: string[],
  hasNikki: boolean
): string {
  const lines = [
    '---',
    `date: ${katachi.date}`,
    `title: ${yamlString(katachi.title)}`,
    // 日記の説明文（原本なので実名のまま）。空なら書かない（説明の無いかたちの控えは今までと同じ形）
    ...(katachi.description ? [`description: ${yamlString(katachi.description)}`] : []),
    `nikki: ${hasNikki ? 'true' : 'false'}`,
    '---',
    '',
  ];
  for (const k of kakera) {
    const pos = publishedIds.indexOf(k.id);
    const mark = pos >= 0 ? `日記 #${pos + 1}` : '非公開';
    lines.push(`<!-- ${k.id} | ${k.written_at.slice(11, 16)} | ${mark} -->`);
    lines.push(k.body);
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------- 書き出しの入口 ---------------- */

export async function backupKakera(ref: RepoRef, k: Kakera, verb: 'create' | 'update'): Promise<void> {
  await putText(ref, kakeraPath(k), renderKakeraFile(k), `${verb}(kakera): ${k.id}`);
}

export async function removeKakera(ref: RepoRef, k: Pick<Kakera, 'id' | 'written_at'>): Promise<void> {
  await deleteFile(ref, kakeraPath(k), `delete(kakera): ${k.id}`);
}

export async function backupKatachi(
  ref: RepoRef,
  katachi: Katachi,
  kakera: Kakera[],
  publishedIds: string[],
  hasNikki: boolean
): Promise<void> {
  await putText(
    ref,
    katachiPath(katachi.date),
    renderKatachiFile(katachi, kakera, publishedIds, hasNikki),
    `update(katachi): ${katachi.date}`
  );
}

export async function removeKatachi(ref: RepoRef, date: string): Promise<void> {
  await deleteFile(ref, katachiPath(date), `delete(katachi): ${date}`);
}

/**
 * かたちの日付が変わったときの改名。
 * ⚠️ 旧ファイルを必ず消す。blog-cms の「古いファイルが残る」罠を自分で踏まないこと（設計 §4）。
 */
export async function renameKatachi(
  ref: RepoRef,
  oldDate: string,
  katachi: Katachi,
  kakera: Kakera[],
  publishedIds: string[],
  hasNikki: boolean
): Promise<void> {
  await backupKatachi(ref, katachi, kakera, publishedIds, hasNikki);
  if (oldDate !== katachi.date) await removeKatachi(ref, oldDate);
}

/** かけらがかたちへ入った／出たときの移動（kakera/ ⇄ katachi/）。 */
export async function moveKakeraIntoKatachi(ref: RepoRef, kakera: Kakera[]): Promise<void> {
  for (const k of kakera) await removeKakera(ref, k);
}

export async function moveKakeraBackToNagare(ref: RepoRef, k: Kakera): Promise<void> {
  await backupKakera(ref, k, 'create');
}
