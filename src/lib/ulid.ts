// ULID（Crockford Base32・26文字）。端末で採番するので、サーバとクライアントの両方から使う。
// 依存を増やさないために自前。crypto.getRandomValues はブラウザにも Workers にもある。

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（I L O U を除く）
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i]! % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(s: unknown): s is string {
  return typeof s === 'string' && ULID_RE.test(s);
}
