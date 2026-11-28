import type { APIRoute } from 'astro';
import { handle } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { exportRows, renderExport } from '../../lib/kakera/day-search';
import { nowJst } from '../../lib/time';

export const prerender = false;

/**
 * GET /api/export — 全期間を日ごとのテキストに（かけら帳1日のページ設計・段階5）。text/plain・UTF-8。
 * 日ごとに 日付・気分・場所（時刻・名前）・かけら（時刻・本文）。予定と写真は端末にしか無いので入らない。
 * ★表ごとに1回ずつ読む（日ごとに引かない）
 */
export const GET: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const now = nowJst();
    const text = renderExport(await exportRows(env.DB), now);
    return new Response(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="kakera-${now.slice(0, 10)}.txt"`,
      },
    });
  });
