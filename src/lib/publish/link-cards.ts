// astro-blog へ渡すリンクカードのキャッシュ JSON（リンクカード設計 §5.2・§6）。
//
// ⚠️ astro-blog は public。**その日記に出る URL のぶんだけ**を載せる（日記にしていないかけらの URL は載せない）。
// ⚠️ **追記しかしない**（既存のキーは消さない。同じキーは新しい値で上書き）。
// ⚠️ 失敗記録（status='failed'）は載せない。
// 形は astro-blog の src/plugins/remark-link-card.ts（toCardView）が読む形に合わせる。

import type { LinkCardRow } from '../kakera/db';
import { domainOf } from '../card/url';
import { isSafePhotoKey, publicKeyFor, publicUrlFor } from './photos';

export const LINK_CARDS_PATH = 'src/data/link-cards.json';

/** JSON の値（LinkCard から url を抜いたもの）。 */
export interface LinkCardJson {
  title: string;
  description: string;
  siteName: string;
  domain: string;
  /** 公開バケットの絶対 URL。無ければ null */
  image: string | null;
}

/** カード画像の非公開 key か（写真の key はここを通さない）。 */
export function isCardImageKey(key: string | null | undefined): key is string {
  return !!key && key.startsWith('kakera/cards/') && isSafePhotoKey(key);
}

/**
 * カード画像の公開 key。`kakera/cards/<hash>.<ext>` → `diary/cards/<hash>.<ext>`。
 * 非公開の key（＝正規化 URL のハッシュ）から決まるので、何度書き出しても同じ場所を上書きするだけ。
 */
export function publicCardImageKey(imageKey: string | null | undefined): string | null {
  return isCardImageKey(imageKey) ? publicKeyFor(imageKey) : null;
}

/** D1 の行を JSON の値にする。failed・形のおかしい行は null（載せない）。 */
export function toCardJson(row: LinkCardRow, image: string | null): LinkCardJson | null {
  if (row.status !== 'ok') return null;
  const domain = domainOf(row.final_url ?? row.url) || domainOf(row.url);
  const title = (row.title ?? '').trim() || domain;
  if (!title) return null;
  return {
    title,
    description: row.description ?? '',
    siteName: row.site_name || domain,
    domain,
    image,
  };
}

/** キーを辞書順に並べ直した値（入れ子のオブジェクトも）。比較と書き出しの両方に使う。 */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
    return out;
  }
  return v;
}

/** キーの順を安定させた整形（2スペース・末尾改行）。 */
export function stringifyCards(cards: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(cards), null, 2) + '\n';
}

export class LinkCardsJsonError extends Error {}

/**
 * 既存の JSON（無ければ null）に今回のカードを足す。消さない・同じキーは上書き。
 * 中身が変わらなければ changed: false（commit しない）。
 * ⚠️ 既存が壊れている（JSON でない・トップレベルがオブジェクトでない）ときは投げる。
 *    `{}` と見なして書くと、既存のカードを全部消してしまうため。
 */
export function mergeCardsJson(
  existingText: string | null,
  entries: Record<string, LinkCardJson>
): { text: string; changed: boolean } {
  let existing: Record<string, unknown> = {};
  if (existingText !== null) {
    // ファイルはあるのに中身が空（Contents API は 1MB を超えると本文を返さない等）も、壊れているのと同じに扱う
    if (existingText.trim() === '') throw new LinkCardsJsonError('ファイルはありますが中身を読めません');
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      throw new LinkCardsJsonError('JSON として読めません');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LinkCardsJsonError('トップレベルがオブジェクトではありません');
    }
    existing = parsed as Record<string, unknown>;
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(entries)) merged[k] = v;
  const text = stringifyCards(merged);
  const changed = existingText === null || stringifyCards(existing) !== text;
  return { text, changed };
}

/**
 * カードの行から JSON の値を作る。画像は公開バケットへコピーして、その公開 URL を入れる。
 * コピーに失敗したカードは image: null で載せる（カード自体は出す）。
 */
export async function buildCardEntries(env: Env, rows: LinkCardRow[]): Promise<Record<string, LinkCardJson>> {
  const out: Record<string, LinkCardJson> = {};
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    let image: string | null = null;
    const publicKey = publicCardImageKey(row.image_key);
    if (publicKey && row.image_key) {
      try {
        const obj = await env.PHOTOS.get(row.image_key);
        if (obj) {
          // ⚠️ R2 は長さの分からないストリームを受け取らない。obj.body をそのまま渡さない
          await env.IMAGES.put(publicKey, await obj.arrayBuffer(), {
            httpMetadata: { contentType: obj.httpMetadata?.contentType ?? 'image/jpeg' },
          });
          image = publicUrlFor(publicKey);
        } else {
          console.error('[link-card] 公開コピー: 非公開バケットに画像がありません', row.image_key);
        }
      } catch (e) {
        console.error('[link-card] 公開コピーに失敗', row.image_key, e instanceof Error ? e.message : e);
      }
    }
    const card = toCardJson(row, image);
    if (card) out[row.url] = card;
  }
  return out;
}
