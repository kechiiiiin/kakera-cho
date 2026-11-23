import { defineMiddleware } from 'astro:middleware';
import { verifyAccess } from './lib/auth/sekisho';

// 第一段は Cloudflare Access のみ（設計 §6）。
// ホスト全体を Access で保護し、middleware は Cf-Access-Jwt-Assertion を
// 関所（sekisho・認証 Worker）に Service Binding の RPC で確かめてもらう（src/lib/auth/sekisho.ts）。**fail-closed**。
//
// iOS アプリは Access のサービストークン（CF-Access-Client-Id / Secret）で来る。Access がそれを JWT に替えるので、
// 同じ Cf-Access-Jwt-Assertion を関所に見せ、{ kind: 'service' } なら ACCESS_SERVICE_CLIENT_IDS と照合する。

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

  // 不正・期限切れ・許可メール外・関所の不調・設定漏れは 401、許可リスト外のサービストークンは 403（他の経路へフォールスルーしない）
  const auth = await verifyAccess(request, env);
  if (!auth.ok) {
    return new Response(auth.status === 403 ? 'Forbidden' : 'Unauthorized', { status: auth.status });
  }

  // ブラウザはメール、サービストークンは service:<Client ID の先頭8文字>（名乗りとしてだけ使う）
  locals.user = { email: auth.email };
  return next();
});
