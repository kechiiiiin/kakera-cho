// 写真の置き場。原本は非公開バケット（kakera-photos）にだけ置く。
//
// 公開バケットに置いてから後で移すと、D1 のかけら本文と控えのファイルの両方で URL を
// 書き換える羽目になる。だから最初から非公開に置き、日記に出すときだけ公開へコピーして、
// 公開版の本文の URL だけを差し替える（原本の本文は触らない・設計 §10）。
// 顔を隠す写真は、変換ページで作ったモザイク済みの版をコピーする（顔モザイク設計）。

import { ApiError } from '../http';
import { faceFingerprint, isFacePhotoKey, isPublicKeyOf, maskedKeyFor, maskedPublicKeyFor, publicPrefixFor } from './photo-face';
import { loadFaces } from './photo-face-db';

/** 非公開バケットの key を、認証の裏から読む相対 URL にする。かけらの本文にはこれを書く。 */
export function photoUrlFor(key: string): string {
  return `/api/photo/${key}`;
}

/** 本文中の URL から非公開バケットの key を取り戻す（かけら帳が置いたものだけ）。 */
export function keyFromPhotoUrl(url: string): string | null {
  if (!url.startsWith('/api/photo/')) return null;
  const key = url.slice('/api/photo/'.length);
  return isSafePhotoKey(key) ? key : null;
}

/**
 * 置き場所を抜け出す key を弾く。
 * プロキシは認証の裏とはいえ、任意の key を読ませない。
 */
export function isSafePhotoKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes('..') || key.startsWith('/')) return false;
  // kakera/cards/… はリンクカードの画像（リンクカード設計 §5.1）
  return /^kakera\/(?:\d{4}\/\d{2}|cards)\/[A-Za-z0-9_.-]+$/.test(key);
}

/**
 * 公開バケットでの key（素顔の版）。非公開の key から決まるので、組み直して何度書き出しても
 * 同じ場所を上書きするだけで済む（コピーが溜まらない）。
 * 顔を隠す写真は指紋入りの別の key（photo-face.ts の maskedPublicKeyFor）。
 * 先頭は blog-cms と同じ `diary/`。
 */
export function publicKeyFor(privateKey: string): string {
  return 'diary/' + privateKey.replace(/^kakera\//, '');
}

export function publicUrlFor(publicKey: string): string {
  return `https://images.kechiiiiin.com/${publicKey}`;
}

/**
 * 公開バケットへコピーする写真の URL（本文に出てくる順・重複なし）。
 * @param skipKeys 日記に出さない写真の key。本文から除き漏れがあっても、これに入っていればコピーしない
 *   （残っても非公開の /api/photo/… のままなので、公開側では開けない＝外に出ない）
 */
export function photoUrlsToCopy(bodies: string[], skipKeys: ReadonlySet<string> = new Set()): string[] {
  const urls = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const body of bodies) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(body))) urls.add(m[1]!);
  }
  return [...urls].filter((url) => {
    const key = keyFromPhotoUrl(url);
    return !key || !skipKeys.has(key);
  });
}

/** 写真 1 枚をどこからどこへコピーするか（書き出しの前に全部決める）。 */
export interface PhotoCopyPlan {
  /** 本文中の非公開 URL（/api/photo/…） */
  url: string;
  /** kakera-photos の key（原本） */
  key: string;
  /** コピー元（原本か、モザイク済みの版） */
  from: string;
  /** 公開バケットでの key（モザイク済みなら指紋入り） */
  to: string;
  /** モザイク済みの版を出すか */
  masked: boolean;
}

/**
 * 公開バケットへのコピーを決める（顔モザイク設計 §3.4）。**何もコピーしないうちに**全部を検める。
 *
 * - 隠す枠がある写真は、原本ではなく**モザイク済みの版**をコピーする。公開 key に指紋を入れる
 * - 隠す枠があるのに、いまの指紋に合うモザイク済みの版が無ければ 409 で止めて理由を出す（素顔のまま外へ出さない）
 * - 顔の検出が済んでいるかは見ない（2026-10-12 §2.1 で変更。検出は「顔を探す」を押したときだけ）。
 *   検出していない写真でも、手で囲んだ隠す枠があればモザイク済みの版を出し、隠す枠が無ければ原本をそのまま出す
 * - 原本が非公開バケットに無い写真（ローカル）は、今までどおり対応表に入れない（公開側では開けない＝外に出ない）
 * - リンクカードの画像（kakera/cards/…）は対象外（原本をそのまま）
 */
export async function planPhotoCopies(
  env: Env,
  bodies: string[],
  skipKeys: ReadonlySet<string> = new Set()
): Promise<PhotoCopyPlan[]> {
  const targets: { url: string; key: string }[] = [];
  for (const url of photoUrlsToCopy(bodies, skipKeys)) {
    const key = keyFromPhotoUrl(url);
    if (key) targets.push({ url, key }); // 外部の画像はそのまま
  }
  const faces = await loadFaces(
    env.DB,
    targets.map((t) => t.key)
  );

  const plans: PhotoCopyPlan[] = [];
  const unmasked: string[] = [];
  for (const { url, key } of targets) {
    if (!(await env.PHOTOS.head(key))) continue;
    const f = faces.get(key);
    if (!f) {
      plans.push({ url, key, from: key, to: publicKeyFor(key), masked: false });
      continue;
    }
    const fp = await faceFingerprint(f.faces);
    if (!fp) {
      plans.push({ url, key, from: key, to: publicKeyFor(key), masked: false });
      continue;
    }
    const from = maskedKeyFor(key, fp);
    if (!(await env.PHOTOS.head(from))) {
      unmasked.push(key);
      continue;
    }
    plans.push({ url, key, from, to: maskedPublicKeyFor(key, fp), masked: true });
  }

  if (unmasked.length) {
    throw new ApiError(
      409,
      `顔を隠す写真のうち ${unmasked.length} 枚は、モザイクをかけた版がまだできていません。素顔のまま出さないよう、書き出していません。変換の画面を開き直してから書き出してください。`
    );
  }
  return plans;
}

/** 書き出しの後で消す、同じ写真の古い公開 key の目印（写真の key と、残す公開 key）。 */
export interface StalePublicKeys {
  /** kakera-photos の key（この写真の公開 key を isPublicKeyOf で見分ける） */
  key: string;
  /** いま置いた公開 key（これだけ残す） */
  keep: string;
}

/**
 * 本文に出てくる写真を公開バケットへコピーし、「非公開 URL → 公開 URL」の対応表と、
 * 後で消す古い公開 key の目印を返す。
 * 公開バケットが無い環境（ローカル）では、コピーできなかったものを対応表に入れない。
 * ⚠️ 渡す本文は、日記に出さない写真を除いた後のもの（出さない写真はコピーしない）。
 * ⚠️ 隠す枠があるのにモザイク済みの版が無い写真があれば、何もコピーせずに 409（planPhotoCopies）。
 *
 * 同じ写真の古い公開 key（素顔の版・前の指紋の版）は**ここでは消さない**（2026-10-12 レビューで変更）。
 * 公開中の日記はまだ古い key を指しているので、日記の commit が通ってから dropOldPublicKeys で消す（astro-blog.ts）。
 */
export async function copyPhotosForPublish(
  env: Env,
  bodies: string[],
  skipKeys: ReadonlySet<string> = new Set()
): Promise<{ map: Map<string, string>; stale: StalePublicKeys[] }> {
  const map = new Map<string, string>();
  const stale: StalePublicKeys[] = [];

  for (const plan of await planPhotoCopies(env, bodies, skipKeys)) {
    const obj = await env.PHOTOS.get(plan.from);
    if (!obj) continue;
    // ⚠️ R2 は長さの分からないストリームを受け取らない。obj.body をそのまま渡さない
    await env.IMAGES.put(plan.to, await obj.arrayBuffer(), {
      httpMetadata: { contentType: plan.masked ? 'image/jpeg' : (obj.httpMetadata?.contentType ?? 'image/jpeg') },
    });
    if (isFacePhotoKey(plan.key)) stale.push({ key: plan.key, keep: plan.to });
    map.set(plan.url, publicUrlFor(plan.to));
  }
  return { map, stale };
}

/**
 * 同じ写真の公開 key のうち、いま置いたもの以外を公開バケットから消す（日記の commit が通った後に呼ぶ）。
 * 一覧は同じかけらの写真（…_<ULID>_1. と _2. など）をまとめて一度だけ引く。残す key しか無ければ消しに行かない。
 * 消せなかった key は次に書き出したときにまた拾われる（一覧から探し直すので、記録を持たなくてよい）。
 * @returns 古い key を消しきれなかった写真の枚数（0 なら全部消せた）。投げない
 */
export async function dropOldPublicKeys(env: Env, stale: StalePublicKeys[]): Promise<number> {
  // 同じかけらの写真は前方一致の頭（連番の手前まで）が同じ。そこでまとめる
  const groups = new Map<string, StalePublicKeys[]>();
  for (const s of stale) {
    const head = publicPrefixFor(s.key).replace(/_\d+\.$/, '_');
    groups.set(head, [...(groups.get(head) ?? []), s]);
  }
  let failed = 0;
  for (const [head, items] of groups) {
    const keep = new Set(items.map((i) => i.keep));
    const old: string[] = [];
    const owners = new Set<StalePublicKeys>();
    try {
      let cursor: string | undefined;
      do {
        const page = await env.IMAGES.list({ prefix: head, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) {
          if (keep.has(o.key)) continue;
          const owner = items.find((i) => isPublicKeyOf(i.key, o.key));
          if (!owner) continue;
          old.push(o.key);
          owners.add(owner);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      // R2 の delete は一度に 1000 件まで
      for (let i = 0; i < old.length; i += 1000) await env.IMAGES.delete(old.slice(i, i + 1000));
    } catch (e) {
      console.error('[publish] drop old public keys', head, e instanceof Error ? e.message : e);
      // 一覧から失敗したときは、どの写真に古い key があったか分からない。まとめた写真を全部数える
      failed += owners.size || items.length;
    }
  }
  return failed;
}
