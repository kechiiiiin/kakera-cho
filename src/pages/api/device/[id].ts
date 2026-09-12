import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';

export const prerender = false;

/** DELETE /api/device/:id — 失効（行を消すだけ） */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const res = await env.DB.prepare('DELETE FROM device WHERE id = ?').bind(params.id).run();
    if (!res.meta.changes) throw new ApiError(404, 'その端末はありません');
    return json({ ok: true });
  });
