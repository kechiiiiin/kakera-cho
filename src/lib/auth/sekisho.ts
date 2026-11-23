// Cloudflare Access の JWT の検証は関所（sekisho・Cloudflare Access の JWT を検証する認証 Worker）に
// Service Binding（SEKISHO）の RPC で聞く。かけら帳が持つのは自分の Access アプリの AUD（CF_ACCESS_AUD）と binding だけ。
// RS256・JWKS・iss/aud/exp/nbf・許可メールは関所の側で見る（sekisho の README）。
//
// **fail-closed**: binding 未設定・verify が関数でない・AUD 空・トークン無し・関所の例外・3 秒の打ち切り・
// 想定外の戻り値は全部「通さない」。通すのは次の二つだけ:
//   - 関所が { kind: 'user' } を返したとき（ブラウザ。許可メールは関所の側で見ている）
//   - 関所が { kind: 'service', clientId } を返し、clientId が ACCESS_SERVICE_CLIENT_IDS（secret・カンマ区切り）に
//     小文字で一致したとき（iOS アプリ。**未設定・空なら1本も通さない**）。形は便り（tayori）の worker/src/auth.ts と同じ
// 関所は allowServiceTokens: true で呼ぶ（どのサービストークンを通すかはこちらの allowlist が決める）。

/** 関所の名乗り */
export type SekishoPrincipal = { kind: 'user'; email: string } | { kind: 'service'; clientId: string };

/** 関所の RPC（sekisho の default export の WorkerEntrypoint） */
export interface Sekisho {
  verify(
    token: string | null | undefined,
    aud: string,
    opts?: { allowServiceTokens?: boolean },
  ): Promise<SekishoPrincipal | null>;
}

export interface AccessEnv {
  SEKISHO?: Sekisho;
  CF_ACCESS_AUD?: string;
  /** 通すサービストークンの Client ID（カンマ区切り）。未設定なら1本も通さない */
  ACCESS_SERVICE_CLIENT_IDS?: string;
}

/** 関所の RPC を待つ上限。過ぎたら認証なし扱い */
export const SEKISHO_TIMEOUT_MS = 3000;

/**
 * 401 = 認証が無い・通らない（関所が null・例外・時間切れ・設定漏れ）。403 = 許可リスト外のサービストークン。
 * 通ったときの email はブラウザならメール（小文字）、サービストークンなら `service:<Client ID の先頭8文字>`（名乗り）
 */
export type AccessResult = { ok: true; email: string } | { ok: false; status: 401 | 403 };

/** カンマ区切りを小文字のリストに（空は落とす） */
export function parseList(raw: string | undefined): string[] {
  return (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * サービストークンの Client ID を allowlist（parseList 済み＝小文字）と照合する。許されないときは null（＝403）。
 * 名乗りはログに出ることがあるので、Client ID を丸ごとは載せない（便りと同じ）
 */
export function servicePrincipal(clientId: string, allowed: string[]): string | null {
  const cn = clientId.trim().toLowerCase();
  if (!cn || allowed.length === 0 || !allowed.includes(cn)) return null;
  return `service:${cn.slice(0, 8)}`;
}

const TIMEOUT = Symbol('timeout');

async function askSekisho(
  sekisho: Sekisho,
  token: string,
  aud: string,
  timeoutMs: number,
): Promise<SekishoPrincipal | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const p: unknown = await Promise.race([sekisho.verify(token, aud, { allowServiceTokens: true }), timeout]);
    if (p === TIMEOUT) {
      console.warn('[kakera-cho:access] 関所が時間内に答えない');
      return null;
    }
    if (!p || typeof p !== 'object') return null;
    const r = p as Record<string, unknown>;
    if (r.kind === 'user' && typeof r.email === 'string' && r.email) return { kind: 'user', email: r.email };
    if (r.kind === 'service' && typeof r.clientId === 'string' && r.clientId) return { kind: 'service', clientId: r.clientId };
    return null;
  } catch (e) {
    console.warn('[kakera-cho:access] 関所の呼び出しに失敗 ' + (e instanceof Error ? e.name : 'error'));
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Cf-Access-Jwt-Assertion を関所に確かめてもらう */
export async function verifyAccess(
  request: Request,
  env: AccessEnv | undefined,
  opts?: { timeoutMs?: number },
): Promise<AccessResult> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const aud = typeof env?.CF_ACCESS_AUD === 'string' ? env.CF_ACCESS_AUD.trim() : '';
  const sekisho = env?.SEKISHO;
  if (!token || !aud || !sekisho || typeof sekisho.verify !== 'function') return { ok: false, status: 401 };
  const p = await askSekisho(sekisho, token, aud, opts?.timeoutMs ?? SEKISHO_TIMEOUT_MS);
  if (!p) return { ok: false, status: 401 };
  if (p.kind === 'user') return { ok: true, email: p.email.toLowerCase() };
  const principal = servicePrincipal(p.clientId, parseList(env?.ACCESS_SERVICE_CLIENT_IDS));
  if (!principal) return { ok: false, status: 403 };
  return { ok: true, email: principal };
}
