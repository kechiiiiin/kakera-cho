// 写真の置き場。原本は非公開バケット（kakera-photos）にだけ置く。
//
// 公開バケットに置いてから後で移すと、D1 のかけら本文と控えのファイルの両方で URL を
// 書き換える羽目になる。だから最初から非公開に置き、日記に出すときだけ公開へコピーして、
// 公開版の本文の URL だけを差し替える（原本の本文は触らない・設計 §10）。

/** 非公開バケットの key を、認証の裏から読む相対 URL にする。かけらの本文にはこれを書く。 */
export function photoUrlFor(key: string): string {
  return `/api/photo/${key}`;
}

/** 本文中の URL から非公開バケットの key を取り戻す（かけら帳が置いたものだけ）。 */
export function keyFromPhotoUrl(url: string): string | null {
  if (!url.startsWith('/api/photo/')) return null;
  const key = url.slice('/api/photo/'.length);
  return isSafePhotoKey(key) ? key : null;
}

/**
 * 置き場所を抜け出す key を弾く。
 * プロキシは認証の裏とはいえ、任意の key を読ませない。
 */
export function isSafePhotoKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes('..') || key.startsWith('/')) return false;
  return /^kakera\/\d{4}\/\d{2}\/[A-Za-z0-9_.-]+$/.test(key);
}

/**
 * 公開バケットでの key。非公開の key から決まるので、組み直して何度書き出しても
 * 同じ場所を上書きするだけで済む（コピーが溜まらない）。
 * 先頭は blog-cms と同じ `diary/`。
 */
export function publicKeyFor(privateKey: string): string {
  return 'diary/' + privateKey.replace(/^kakera\//, '');
}

export function publicUrlFor(publicKey: string): string {
  return `https://images.kechiiiiin.com/${publicKey}`;
}

/**
 * 本文に出てくる写真を公開バケットへコピーし、「非公開 URL → 公開 URL」の対応表を返す。
 * 公開バケットが無い環境（ローカル）では、コピーできなかったものを対応表に入れない。
 */
export async function copyPhotosForPublish(
  env: Env,
  bodies: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const urls = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const body of bodies) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(body))) urls.add(m[1]!);
  }

  for (const url of urls) {
    const key = keyFromPhotoUrl(url);
    if (!key) continue; // 外部の画像はそのまま
    const obj = await env.PHOTOS.get(key);
    if (!obj) continue;
    const publicKey = publicKeyFor(key);
    await env.IMAGES.put(publicKey, obj.body, {
      httpMetadata: { contentType: obj.httpMetadata?.contentType ?? 'image/jpeg' },
    });
    map.set(url, publicUrlFor(publicKey));
  }
  return map;
}
