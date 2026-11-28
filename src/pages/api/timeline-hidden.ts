import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { parseDateParam, parseHiddenCreate, parseHiddenKey } from '../../lib/kakera/day-input';
import { addHidden, listHiddenOn, removeHidden } from '../../lib/kakera/day-db';

export const prerender = false;

// 端末のカレンダーの予定・写真を、その日の一覧から外した印（かけら帳1日のページ設計）。本体（カレンダー・写真）は消さない。
// 段階1では口だけ用意する（画面が使うのは段階2・3）。控えには載せない（見せ方なので）。

/** GET /api/timeline-hidden?date=YYYY-MM-DD → {hidden: [{kind, ref, date, created_at}]} */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const date = parseDateParam(url.searchParams.get('date'));
    return json({ hidden: await listHiddenOn(env.DB, date) });
  });

/** POST /api/timeline-hidden — {kind: event|photo, ref, date} → 201 {hidden}。同じものをもう一度送っても1行 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const hidden = await addHidden(env.DB, parseHiddenCreate(await readJson(request)));
    return json({ hidden }, 201);
  });

/** DELETE /api/timeline-hidden?kind=event|photo&ref=... → {ok: true, removed}（写真の ref は / を含むので問い合わせで受ける） */
export const DELETE: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const key = parseHiddenKey({ kind: url.searchParams.get('kind'), ref: url.searchParams.get('ref') });
    return json({ ok: true, ...(await removeHidden(env.DB, key)) });
  });
