// og:image を非公開バケット kakera-photos に取り込む（リンクカード設計 §5.1）。
// 写真と同じ二段: 原本は非公開・読むのは /api/photo/* の認証の裏・公開は日記に出すときだけ（第二段）。
//
// 取り込まないもの（＝画像なしのカードにする）:
//  - image/jpeg png gif webp avif 以外（⚠️ SVG はスクリプトを書けるので自分のドメインから配らない）
//  - 5MB を超えるもの・中身の先頭が宣言した形式と合わないもの
//  - 内向きのホスト（SSRF よけは本文の取得と同じ safeFetch を通す）

import { TIMEOUT_MS, UA, readCapped, safeFetch } from './fetch';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** 中身の先頭が宣言した形式か（HTML を image/png と偽って置かせない）。 */
function looksLike(ext: string, b: Uint8Array): boolean {
  const at = (i: number, s: string): boolean => {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  switch (ext) {
    case 'jpg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'png':
      return b[0] === 0x89 && at(1, 'PNG');
    case 'gif':
      return at(0, 'GIF8');
    case 'webp':
      return at(0, 'RIFF') && at(8, 'WEBP');
    case 'avif':
      return at(4, 'ftyp');
    default:
      return false;
  }
}

async function sha256Hex16(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * 画像を取って R2 に置き、key を返す。取り込めなければ null（理由は console に残す）。
 * key は正規化 URL のハッシュから決まるので、同じ URL は何度取り込んでも同じ場所を上書きするだけ。
 */
export async function importCardImage(
  env: Env,
  cardKey: string,
  imageUrl: string,
  referer: string
): Promise<string | null> {
  const fetched = await safeFetch(imageUrl, {
    // ⚠️ referer を付ける。og:image を hotlink 対策で弾くサイトがある
    headers: { 'user-agent': UA, referer, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!fetched.ok) {
    console.error('[link-card] image', imageUrl, fetched.error);
    return null;
  }
  const { res } = fetched;
  const skip = async (why: string): Promise<null> => {
    await res.body?.cancel().catch(() => undefined);
    console.error('[link-card] image', imageUrl, why);
    return null;
  };

  if (!res.ok) return skip(`http ${res.status}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) return skip(`type ${contentType || '(none)'}`);
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return skip('too large');

  const { bytes, truncated } = await readCapped(res, MAX_IMAGE_BYTES + 1);
  if (truncated || bytes.byteLength > MAX_IMAGE_BYTES) return skip('too large');
  if (!looksLike(ext, bytes)) return skip('content mismatch');

  const key = `kakera/cards/${await sha256Hex16(cardKey)}.${ext}`;
  // ⚠️ R2 は長さの分からないストリームを受け取らない。読み切ったバイト列を渡す
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: contentType === 'image/jpg' || contentType === 'image/pjpeg' ? 'image/jpeg' : contentType } });
  return key;
}
