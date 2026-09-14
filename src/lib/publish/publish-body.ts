// 日記用に直した文（公開名変換設計・記号方式）。画面とサーバの両方から使う純関数だけ。
//
// 決まり:
//  - かけら一枚ごとに「日記に出す文」をまるごと持つ。持ち方は name_doc の kind = 'publish' の文書（文書そのものが正）
//  - 原本（D1 のかけら・控え）は触らない
//  - basis = 書き換えた（または「書き換えを使う」を選んだ）時点の kakera.updated_at。今と違えば「原本が変わっています」
//    と知らせるだけ。選ぶまでは書き換えを使う

/** 画面に渡す形（文は docs に載る）。 */
export interface PublishBodyView {
  kakera_id: string;
  basis: string;
  updated_at: string;
  /** 書き換えた後に原本が直された */
  stale: boolean;
}

/** 受け取れる文に整える（原本の保存と同じく前後の空白を落とす）。空なら null。 */
export function cleanPublishBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s ? s : null;
}

/** 書き換えた後に原本が直されたか。 */
export function isPublishBodyStale(kakeraUpdatedAt: string, basis: string): boolean {
  return basis !== kakeraUpdatedAt;
}

/**
 * 写真の選択を突き合わせるときの本文＝原本と日記用の文（実名で解いた文）を並べたもの。
 * 「日記に出さない」を**原本か日記用の文のどちらかに実在する写真の key**まで残すため。
 * 日記用の文で写真の記法を消した後に選び直しても、原本にある写真の「出さない」が消えず、
 * 原本に戻したときに出さないはずの写真が黙って出ることが無い。
 * 公開版の本文から除く範囲は書き出す文だけで計算するので、ここで足した key は余計に効かない。
 */
export function photoBasisOf<K extends { id: string; body: string }>(
  original: K[],
  bodies: ReadonlyArray<{ kakera_id: string; body: string }>
): K[] {
  const byId = new Map(bodies.map((b) => [b.kakera_id, b.body]));
  return original.map((k) => {
    const body = byId.get(k.id);
    // 空行を挟むので、原本の末尾と書き換えの頭が一つの記法として読まれることは無い（リンクは空行を跨がない）
    return body === undefined ? k : { ...k, body: `${k.body}\n\n${body}` };
  });
}
