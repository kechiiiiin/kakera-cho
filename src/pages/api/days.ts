import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { isMonthKey, monthDays } from '../../lib/kakera/day-search';

export const prerender = false;

/**
 * GET /api/days?month=YYYY-MM — 月カレンダー（かけら帳1日のページ設計・段階5）
 * → {month, days: [{date, kakera, places, mood}]}。かけら・場所・気分のどれかがある日だけ（日付順）
 */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const month = url.searchParams.get('month');
    if (!isMonthKey(month)) throw new ApiError(400, 'month は YYYY-MM で送ってください');
    return json({ month, days: await monthDays(env.DB, month) });
  });
