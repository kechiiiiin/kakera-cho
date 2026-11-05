// 関所（SEKISHO の Service Binding）の呼び出し（src/lib/auth/sekisho.ts）。関所はモックする
import { describe, expect, it, vi } from 'vitest';
import { verifyAccess, type Sekisho, type SekishoPrincipal } from './sekisho';

const AUD = 'aud-tag-123';
const EMAIL = 'someone@example.com';
const GOOD = 'good.jwt.token';
const SERVICE = 'service.jwt.token';

/** GOOD はユーザー、SERVICE はサービストークン、それ以外・aud 違いは null */
const mockSekisho = (impl?: Sekisho['verify']) => {
  const verify = vi.fn<Sekisho['verify']>(
    impl ??
      (async (token, aud): Promise<SekishoPrincipal | null> => {
        if (aud !== AUD) return null;
        if (token === GOOD) return { kind: 'user', email: 'Someone@Example.com' };
        if (token === SERVICE) return { kind: 'service', clientId: 'cid.access' };
        return null;
      }),
  );
  return { SEKISHO: { verify } satisfies Sekisho, verify };
};

const req = (token?: string) =>
  new Request('https://kakera.example.com/api/kakera', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  });

describe('verifyAccess', () => {
  it('認証済み（関所が user）は通り、email は小文字。AUD とトークンだけ渡す（allowServiceTokens は渡さない）', async () => {
    const { SEKISHO, verify } = mockSekisho();
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: ` ${AUD} ` })).toEqual({ ok: true, email: EMAIL });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]).toEqual([GOOD, AUD]);
  });

  it('未認証: トークン無しは関所に聞かずに 401、不正トークン・aud 違いも 401', async () => {
    const { SEKISHO, verify } = mockSekisho();
    expect(await verifyAccess(req(), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(verify).not.toHaveBeenCalled();
    expect(await verifyAccess(req('bad.jwt.token'), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: 'other' })).toEqual({ ok: false, status: 401 });
  });

  it('関所が service を返したら拒否（403）', async () => {
    const { SEKISHO } = mockSekisho();
    expect(await verifyAccess(req(SERVICE), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 403 });
  });

  it('関所が throw したら拒否（401）', async () => {
    const { SEKISHO } = mockSekisho(async () => {
      throw new Error('Service binding unavailable');
    });
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
  });

  it('関所が既定の 3 秒以内に答えなければ拒否（401）', async () => {
    vi.useFakeTimers();
    try {
      const { SEKISHO } = mockSekisho(() => new Promise<SekishoPrincipal | null>(() => {}));
      const pending = verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: AUD });
      await vi.advanceTimersByTimeAsync(2999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, status: 401 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('想定外の戻り値は拒否（401）', async () => {
    for (const odd of [{ kind: 'user' }, { kind: 'user', email: 1 }, { kind: 'admin', email: EMAIL }, 'user', true, undefined]) {
      const { SEKISHO } = mockSekisho(async () => odd as unknown as SekishoPrincipal);
      expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    }
  });

  it('binding 無し・verify が関数でない・AUD 空・env 無しは拒否（401）', async () => {
    const { SEKISHO, verify } = mockSekisho();
    expect(await verifyAccess(req(GOOD), { CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), { SEKISHO: {} as unknown as Sekisho, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: '  ' })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), { SEKISHO })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), undefined)).toEqual({ ok: false, status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });
});
