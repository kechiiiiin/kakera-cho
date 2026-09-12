import type { APIRoute } from 'astro';
import { handle, json } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { searchKatachi } from '../../lib/kakera/db';

export const prerender = false;

/**
 * GET /api/search?q=... — かたちの全文検索（設計 §3・第二段）。
 * 空クエリは検索せず何も返さない。クエリの前後の空白は searchKatachi 側で落とす。
 */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const q = url.searchParams.get('q') ?? '';
    return json({ results: await searchKatachi(env.DB, q) });
  });
