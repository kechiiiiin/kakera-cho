import { defineMiddleware } from 'astro:middleware';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// 第一段は Cloudflare Access のみ（設計 §6）。
// ホスト全体を Access で保護し、middleware は Cf-Access-Jwt-Assertion を
// jose で検証する（JWKS・iss・aud・exp）。**fail-closed**。
//
// Bearer 経路（iOS）は第二段。Access と Bearer は素直に組むと両立しないので、
// ここでは作らない。device テーブルだけは最初から用意してある。

// JWKS はモジュールスコープでキャッシュ（jose が内部で cooldown を管理する）
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * ローカル開発でだけ認証を迂回する。
 *
 * ★本番で効かないことの保証は二重にしてある:
 *   1. `import.meta.env.DEV` はビルド時に false へ静的置換されるので、
 *      本番バンドルではこの関数の中身ごと到達不能になる（dead code）。
 *   2. それでも、ホスト名が localhost/127.0.0.1 のときしか通さない。
 * さらに .dev.vars の DEV_BYPASS_AUTH=1 が要る（三つ揃わないと迂回しない）。
 */
function devBypassAllowed(env: Env | undefined, request: Request): boolean {
  if (!import.meta.env.DEV) return false;
  if (env?.DEV_BYPASS_AUTH !== '1') return false;
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, request } = context;
  const env = locals.runtime?.env as Env | undefined;

  if (devBypassAllowed(env, request)) {
    locals.user = { email: 'dev@localhost' };
    return next();
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env?.CF_ACCESS_TEAM_DOMAIN || !env?.CF_ACCESS_AUD) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    jwks ??= createRemoteJWKSet(new URL(`${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.CF_ACCESS_TEAM_DOMAIN,
      audience: env.CF_ACCESS_AUD,
    });
    const email = String(payload.email ?? '').toLowerCase();

    const allowed = (env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    // allowlist 未設定は全員拒否。設定漏れを裏口にしない
    if (!email || allowed.length === 0 || !allowed.includes(email)) {
      return new Response('Forbidden', { status: 403 });
    }

    locals.user = { email };
    return next();
  } catch {
    // 検証に失敗したら即 401（他の経路へフォールスルーしない）
    return new Response('Unauthorized', { status: 401 });
  }
});
