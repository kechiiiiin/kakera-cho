import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { ulid } from '../../../lib/ulid';
import { nowJst } from '../../../lib/time';

export const prerender = false;

/** 32 バイトの乱数を base64url に。 */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /api/device — {name} → 平文トークンを一度だけ返す。
 * ★平文は保存しない（SHA-256 のハッシュだけ D1 に入れる）。
 * ※Bearer での認証そのものは第二段。ここは表と発行だけ用意しておく。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const input = await readJson(request);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new ApiError(400, '端末の名前を送ってください');

    const token = newToken();
    const id = ulid();
    await env.DB.prepare(
      'INSERT INTO device (id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)'
    )
      .bind(id, name, await sha256Hex(token), nowJst())
      .run();

    // token を返すのはこの一度だけ
    return json({ id, name, token }, 201);
  });
