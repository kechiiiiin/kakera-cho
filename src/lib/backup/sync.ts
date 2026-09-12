// 「D1 が変わったら控えをどう追従させるか」の段取り。
// かたちのファイルは常に D1 の現在の中身で丸ごと書き直す（冪等）ので、
// 途中で失敗しても次の保存で追いつく。

import type { Kakera } from '../kakera/types';
import { getKatachiDetail } from '../kakera/db';
import {
  backupKakera,
  backupKatachi,
  dataRepo,
  removeKakera,
  removeKatachi,
} from './kakera-data';

/** かたち1つぶんの控えを、いまの D1 の中身で書き直す。 */
export async function syncKatachi(env: Env, katachiId: string): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  const detail = await getKatachiDetail(env.DB, katachiId);
  await backupKatachi(ref, detail.katachi, detail.kakera, detail.published_ids, !!detail.nikki);
}

/**
 * かたちの日付が変わったときの改名。
 * ⚠️ 新しい日付で書いてから旧ファイルを消す。blog-cms の「古いファイルが残る」罠を踏まない。
 */
export async function syncKatachiRenamed(env: Env, katachiId: string, oldDate: string): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  const detail = await getKatachiDetail(env.DB, katachiId);
  await backupKatachi(ref, detail.katachi, detail.kakera, detail.published_ids, !!detail.nikki);
  if (oldDate !== detail.katachi.date) await removeKatachi(ref, oldDate);
}

/** かけら1枚が変わったとき。流れにいるなら kakera/、かたちの中なら katachi/ を書き直す。 */
export async function syncKakera(env: Env, k: Kakera): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  if (k.katachi_id) await syncKatachi(env, k.katachi_id);
  else await backupKakera(ref, k, 'update');
}

/** かけらを消したとき。 */
export async function syncKakeraDeleted(env: Env, k: Kakera): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  if (k.katachi_id) await syncKatachi(env, k.katachi_id);
  else await removeKakera(ref, k);
}

/**
 * かたちを作ったとき: かたちのファイルを書き、入ったかけらの kakera/ 側を消す（移動）。
 */
export async function syncKatachiCreated(env: Env, katachiId: string): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  const detail = await getKatachiDetail(env.DB, katachiId);
  await backupKatachi(ref, detail.katachi, detail.kakera, detail.published_ids, !!detail.nikki);
  for (const k of detail.kakera) await removeKakera(ref, k);
}

/** かたちを解いたとき: かたちのファイルを消し、戻ったかけらを kakera/ に生やす。 */
export async function syncKatachiDissolved(env: Env, date: string, kakera: Kakera[]): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  for (const k of kakera) await backupKakera(ref, { ...k, katachi_id: null }, 'create');
  await removeKatachi(ref, date);
}

/** かけら1枚を流れへ戻したとき: かたちを書き直し、そのかけらを kakera/ に生やす。 */
export async function syncKakeraDetached(env: Env, katachiId: string, k: Kakera): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  await backupKakera(ref, k, 'create');
  await syncKatachi(env, katachiId);
}
