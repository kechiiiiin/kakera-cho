// 関所（SEKISHO の Service Binding）の呼び出し（src/lib/auth/sekisho.ts）。関所はモックする
import { describe, expect, it, vi } from 'vitest';
import { parseList, servicePrincipal, verifyAccess, type Sekisho, type SekishoPrincipal } from './sekisho';

const AUD = 'aud-tag-123';
const EMAIL = 'someone@example.com';
const GOOD = 'good.jwt.token';
const SERVICE = 'service.jwt.token';
const OTHER_SERVICE = 'other-service.jwt.token';
const CLIENT_ID = 'abcdef0123456789.access';

/** GOOD はユーザー、SERVICE はサービストークン、それ以外・aud 違いは null */
const mockSekisho = (impl?: Sekisho['verify']) => {
  const verify = vi.fn<Sekisho['verify']>(
    impl ??
      (async (token, aud): Promise<SekishoPrincipal | null> => {
        if (aud !== AUD) return null;
        if (token === GOOD) return { kind: 'user', email: 'Someone@Example.com' };
        if (token === SERVICE) return { kind: 'service', clientId: CLIENT_ID.toUpperCase() };
        if (token === OTHER_SERVICE) return { kind: 'service', clientId: '9999.access' };
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
  it('認証済み（関所が user）は今までどおり通り、email は小文字。関所は allowServiceTokens: true で呼ぶ', async () => {
    const { SEKISHO, verify } = mockSekisho();
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: ` ${AUD} ` })).toEqual({ ok: true, email: EMAIL });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]).toEqual([GOOD, AUD, { allowServiceTokens: true }]);
    // allowlist があってもなくても、ブラウザの扱いは変わらない
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID })).toEqual({ ok: true, email: EMAIL });
  });

  it('未認証: トークン無しは関所に聞かずに 401、不正トークン・aud 違いも 401', async () => {
    const { SEKISHO, verify } = mockSekisho();
    expect(await verifyAccess(req(), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(verify).not.toHaveBeenCalled();
    expect(await verifyAccess(req('bad.jwt.token'), { SEKISHO, CF_ACCESS_AUD: AUD })).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: 'other' })).toEqual({ ok: false, status: 401 });
  });

  it('許可リストのサービストークンは通る（大文字小文字・空白・複数を許す）。名乗りは service:<先頭8文字>', async () => {
    const { SEKISHO } = mockSekisho();
    for (const list of [CLIENT_ID, ` other.access , ${CLIENT_ID.toUpperCase()} `, `,${CLIENT_ID},`]) {
      expect(await verifyAccess(req(SERVICE), { SEKISHO, CF_ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_IDS: list })).toEqual({
        ok: true,
        email: 'service:abcdef01',
      });
    }
  });

  it('許可リスト外のサービストークンは 403。許可リストが未設定・空なら1本も通さない（403）', async () => {
    const { SEKISHO } = mockSekisho();
    const env = { SEKISHO, CF_ACCESS_AUD: AUD };
    expect(await verifyAccess(req(OTHER_SERVICE), { ...env, ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID })).toEqual({ ok: false, status: 403 });
    expect(await verifyAccess(req(SERVICE), env)).toEqual({ ok: false, status: 403 });
    expect(await verifyAccess(req(SERVICE), { ...env, ACCESS_SERVICE_CLIENT_IDS: '' })).toEqual({ ok: false, status: 403 });
    expect(await verifyAccess(req(SERVICE), { ...env, ACCESS_SERVICE_CLIENT_IDS: ' , , ' })).toEqual({ ok: false, status: 403 });
    // 前方一致などでは通さない
    expect(await verifyAccess(req(SERVICE), { ...env, ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID.slice(0, 8) })).toEqual({ ok: false, status: 403 });
  });

  it('許可リストがあっても、トークン無し・関所の否認は 401 のまま', async () => {
    const { SEKISHO } = mockSekisho();
    const env = { SEKISHO, CF_ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID };
    expect(await verifyAccess(req(), env)).toEqual({ ok: false, status: 401 });
    expect(await verifyAccess(req('bad.jwt.token'), env)).toEqual({ ok: false, status: 401 });
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
    for (const odd of [{ kind: 'user' }, { kind: 'user', email: 1 }, { kind: 'service' }, { kind: 'service', clientId: '' }, { kind: 'service', clientId: 1 }, { kind: 'admin', email: EMAIL }, 'user', true, undefined]) {
      const { SEKISHO } = mockSekisho(async () => odd as unknown as SekishoPrincipal);
      expect(await verifyAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID })).toEqual({ ok: false, status: 401 });
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

describe('parseList / servicePrincipal', () => {
  it('parseList は小文字に揃え、空は落とす。未設定は空', () => {
    expect(parseList(' A.access, ,b.ACCESS ')).toEqual(['a.access', 'b.access']);
    expect(parseList(undefined)).toEqual([]);
  });
  it('servicePrincipal は一致したときだけ名乗りを返す', () => {
    expect(servicePrincipal('ABCDEF0123.access', ['abcdef0123.access'])).toBe('service:abcdef01');
    expect(servicePrincipal('x.access', [])).toBeNull();
    expect(servicePrincipal('', [''])).toBeNull();
  });
});
