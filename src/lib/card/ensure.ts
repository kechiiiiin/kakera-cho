// 保存したかけらの URL のカードを、裏で取りに行く（リンクカード設計 §2.1）。
// ⚠️ ここは waitUntil の中で動く。例外は握って console に残し、保存そのものは絶対に失敗させない。

import { getLinkCardRows, upsertLinkCard } from '../kakera/db';
import { errorLabel, fetchPage } from './fetch';
import { importCardImage } from './image';
import { parseCardUrls } from './url';

/**
 * 一度に取りに行く本数の上限。
 * Workers の waitUntil はレスポンス後 30 秒まで、サブリクエストは（無料枠で）1回 50 本まで。
 * 1本あたり 本文＋画像＋リダイレクトで数本使うので、控えめにする。残りは次の保存か補填で拾う。
 */
export const MAX_PER_RUN = 5;
/** この時間を過ぎたら次の URL に取りかからない（取りかかったものは最後までやる）。 */
const RUN_BUDGET_MS = 20_000;
/** failed は 7 日は放っておく（失敗した相手を叩き続けない）。 */
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** 本文からカードのキー（正規化 URL）を重複なく拾う。 */
export function cardKeysOf(bodies: string[]): string[] {
  return [...new Set(bodies.flatMap((b) => parseCardUrls(b).map((t) => t.key)))];
}

/** まだ取りに行くべき URL（キャッシュに無い・または 7 日を過ぎた failed）。 */
export async function pendingCardUrls(db: D1Database, bodies: string[]): Promise<string[]> {
  const keys = cardKeysOf(bodies);
  if (!keys.length) return [];
  const rows = await getLinkCardRows(db, keys);
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const now = Date.now();
  return keys.filter((k) => {
    const row = byUrl.get(k);
    if (!row) return true;
    if (row.status === 'ok') return false;
    const at = Date.parse(row.fetched_at);
    return !Number.isFinite(at) || now - at > FAILED_RETRY_MS;
  });
}

/** 1本取りに行って link_card に書く。失敗も failed として書く。 */
async function fetchOne(env: Env, url: string): Promise<void> {
  try {
    const page = await fetchPage(url);
    if (page.status === 'failed') {
      console.error('[link-card]', url, page.error);
      await upsertLinkCard(env.DB, {
        url,
        status: 'failed',
        title: null,
        description: null,
        site_name: null,
        final_url: page.finalUrl,
        image_key: null,
        error: page.error,
      });
      return;
    }
    let imageKey: string | null = null;
    if (page.imageUrl) {
      try {
        imageKey = await importCardImage(env, url, page.imageUrl, page.finalUrl);
      } catch (e) {
        console.error('[link-card] image', url, errorLabel(e));
      }
    }
    await upsertLinkCard(env.DB, {
      url,
      status: 'ok',
      title: page.title,
      description: page.description,
      site_name: page.siteName,
      final_url: page.finalUrl,
      image_key: imageKey,
      error: null,
    });
  } catch (e) {
    const message = errorLabel(e);
    console.error('[link-card]', url, message);
    try {
      await upsertLinkCard(env.DB, {
        url,
        status: 'failed',
        title: null,
        description: null,
        site_name: null,
        final_url: null,
        image_key: null,
        error: message,
      });
    } catch {
      /* 記録にも失敗したら諦める（次の保存でやり直される） */
    }
  }
}

/**
 * 取りに行っている最中の URL（同じ isolate の中だけ）。
 * 保存や補填を続けて押したとき、まだ行が書かれていない URL を二重に叩かないため。
 */
const inFlight = new Set<string>();

/** 渡された URL を **1本ずつ順に** 取りに行く（同時に叩かない）。 */
export async function fetchCardsInOrder(env: Env, urls: string[]): Promise<void> {
  const started = Date.now();
  const mine = urls.filter((u) => !inFlight.has(u));
  for (const u of mine) inFlight.add(u);
  try {
    for (const url of mine) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      await fetchOne(env, url);
      inFlight.delete(url);
    }
  } finally {
    for (const u of mine) inFlight.delete(u);
  }
}

/** かけらを保存したとき（新規・本文の編集）の入口。 */
export async function ensureCards(env: Env, bodies: string[]): Promise<void> {
  try {
    const pending = await pendingCardUrls(env.DB, bodies);
    if (pending.length) await fetchCardsInOrder(env, pending.slice(0, MAX_PER_RUN));
  } catch (e) {
    console.error('[link-card] ensureCards', errorLabel(e));
  }
}
