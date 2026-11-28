import type { APIRoute } from 'astro';
import { handle, json } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { searchKatachi } from '../../lib/kakera/db';
import { searchDays } from '../../lib/kakera/day-search';

export const prerender = false;

/**
 * GET /api/search?q=... — かたちの全文検索（設計 §3・第二段）。
 * 空クエリは検索せず何も返さない。クエリの前後の空白は searchKatachi 側で落とす。
 *
 * 段階5（かけら帳1日のページ設計）で、results（かたち・今までの形のまま）の横に足した:
 *   kakera: [{id, written_at, excerpt}] … かけら全部（流れも）の本文の一致（新しい順・200まで）
 *   places: [{id, at, name}]             … 場所の名前の一致（新しい順・200まで）
 * Web のかたち一覧と iOS のかたち検索は results だけを読むので変わらない。
 */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const q = url.searchParams.get('q') ?? '';
    const [results, days] = await Promise.all([searchKatachi(env.DB, q), searchDays(env.DB, q)]);
    return json({ results, kakera: days.kakera, places: days.places });
  });
