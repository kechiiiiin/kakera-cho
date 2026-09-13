// 日記にだけ効く文章の微修正（公開名変換設計「日記にだけ効く文章の微修正を作る」・migrations/0008）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。データを返すだけ。
//
// 決まり:
//  - かけら一枚ごとに「日記に出す本文（公開用の本文）」をまるごと持つ。原本（D1 のかけら・控え）は触らない
//  - 書き換えがあるかけらは、名前の当たり箇所・写真・空行の保持・カードの URL を**書き換えた本文**で計算する
//  - 原本を書き換えの後に直したら（kakera.updated_at ≠ basis）知らせるだけ。選ぶまでは書き換えを使う
//
// ⚠️ 名前の選択（name_choice）との持ち分け:
//  name_choice の basis は「そのかけらの本文の版」を表す文字列で、原本では kakera.updated_at。
//  書き換えがあるかけらは basis を**書き換えた本文の中身から作った印**（nameChoiceBasisOf）にする。
//  names/db.ts は Kakera の body と updated_at しか見ないので、書き換えを当てたかけら（applyPublishBodies）を
//  渡すだけで、当たり箇所の計算も選択の白紙判定もそのまま書き換えた本文に乗る。
//   - 書き換えた文章を直す → 印が変わる → そのかけらの名前の選択は白紙（辞書どおり）
//   - 原本だけ直す → 書き換えた本文の印は変わらない → 書き換えに付けた選択は残る
//   - 書き換えを消す（原本に戻す） → basis が kakera.updated_at に戻る → 選択は白紙
//  印は 'pb:' で始まるので、ISO8601 の kakera.updated_at と取り違えない。

/** D1 の行（publish_body）。 */
export interface PublishBody {
  kakera_id: string;
  /** 日記に出す本文（実名のまま） */
  body: string;
  /** 書き換えた（または「書き換えを使う」を選んだ）時点の kakera.updated_at */
  basis: string;
  /** 書き換えた文章を保存した時刻 */
  updated_at: string;
}

/** 画面に渡す形。stale = 書き換えた後に原本が直された。 */
export interface PublishBodyView extends PublishBody {
  stale: boolean;
}

/** 名前の選択の basis の頭（原本の basis＝ISO8601 と取り違えないため）。 */
export const PUBLISH_BODY_BASIS_PREFIX = 'pb:';

/** 受け取れる本文に整える（原本の保存と同じく前後の空白を落とす）。空なら null。 */
export function cleanPublishBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s ? s : null;
}

/** 書き換えた後に原本が直されたか。 */
export function isPublishBodyStale(kakeraUpdatedAt: string, pb: { basis: string }): boolean {
  return pb.basis !== kakeraUpdatedAt;
}

/** FNV-1a（32bit・UTF-16 の単位ごと）。seed を変えて二本取り、取り違えをほぼ無くす。 */
function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 書き換えた本文に付けた名前の選択の basis。中身が同じなら同じ、変われば変わる。
 * （時刻にしないのは、同じ秒に二度直すと白紙に戻らないため）
 */
export function nameChoiceBasisOf(body: string): string {
  return `${PUBLISH_BODY_BASIS_PREFIX}${body.length}:${fnv1a(body, 0x811c9dc5)}${fnv1a(body, 0x9e3779b9)}`;
}

/**
 * 書き換えを当てたかけら。書き換えがあるかけらは body を書き換えた本文に、updated_at を nameChoiceBasisOf に差し替える。
 * ⚠️ これを names/db（当たり箇所・選択の照合と白紙判定）と convertForPublish に渡す。
 * ⚠️ 返したものを原本として保存・控えに書かない（kakera の行は触らない）。
 */
export function applyPublishBodies<K extends { id: string; body: string; updated_at: string }>(
  kakera: K[],
  bodies: ReadonlyArray<Pick<PublishBody, 'kakera_id' | 'body'>>
): K[] {
  const byId = new Map(bodies.map((b) => [b.kakera_id, b.body]));
  return kakera.map((k) => {
    const body = byId.get(k.id);
    return body === undefined ? k : { ...k, body, updated_at: nameChoiceBasisOf(body) };
  });
}

/**
 * 写真の選択を突き合わせるときの本文＝原本と書き換えた本文を並べたもの。
 * 「日記に出さない」を**原本か書き換えのどちらかに実在する写真の key**まで残すため。
 * 書き換えで写真の記法を消した後に選び直しても、原本にある写真の「出さない」が消えず、
 * 原本に戻したときに出さないはずの写真が黙って出ることが無い。
 * 公開版の本文から除く範囲は書き換えた本文だけで計算するので（convertForPublish）、ここで足した key は余計に効かない。
 */
export function photoBasisOf<K extends { id: string; body: string }>(
  original: K[],
  bodies: ReadonlyArray<Pick<PublishBody, 'kakera_id' | 'body'>>
): K[] {
  const byId = new Map(bodies.map((b) => [b.kakera_id, b.body]));
  return original.map((k) => {
    const body = byId.get(k.id);
    // 空行を挟むので、原本の末尾と書き換えの頭が一つの記法として読まれることは無い（リンクは空行を跨がない）
    return body === undefined ? k : { ...k, body: `${k.body}\n\n${body}` };
  });
}
