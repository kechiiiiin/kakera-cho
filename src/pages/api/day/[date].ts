import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { parseDateParam, parseDayPut } from '../../../lib/kakera/day-input';
import { getDay, putDayMood } from '../../../lib/kakera/day-db';
import { syncDays } from '../../../lib/backup/day';

export const prerender = false;

/**
 * GET /api/day/:date — その日（JST）の気分 → {day: {date, mood|null, updated_at|null}}（かけら帳1日のページ設計・段階1）
 * 一度も押していない日も 200（mood: null）。
 */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const date = parseDateParam(params.date);
    return json({ day: await getDay(env.DB, date) });
  });

/** PUT /api/day/:date — {mood: 嬉|楽|穏|疲|哀|null}（null で外す）→ {day}。控え day/YYYY-MM-DD.md も裏で書き直す */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const date = parseDateParam(params.date);
    const { mood } = parseDayPut(await readJson(request));
    const day = await putDayMood(env.DB, date, mood);
    waitUntil(syncDays(env, [date]));
    return json({ day });
  });
