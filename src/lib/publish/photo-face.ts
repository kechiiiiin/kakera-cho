// 写真の顔を、日記に出すときだけ隠す（顔モザイク設計）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。データを返すだけ。
//
// 決まり:
//  - 隠すのは公開するときだけ。原本（kakera-photos）には手を入れず、公開用 images へのコピーにだけモザイクをかける
//  - 枠は**写真の key**に紐づける（かけら単位ではない）。同じ写真が別のかたちに入っても、決めた隠し方を引き継ぐ
//  - 見つけた顔は最初から全部「隠す」（shown = false）。画面で顔ごとに「出す」へ切り替えられる
//  - 座標は写真に対する 0〜1 の比率。小数 4 桁に丸めて持つ（画面とサーバで同じ指紋になるように）
//  - 「枠の指紋」は隠す枠の集合から作るハッシュ（8 桁）。枠を直せば指紋が変わり、モザイク済みの版も公開 key も変わる

/** 顔の枠 1 つ。 */
export interface PhotoFace {
  /** 写真の中での id（自動は a…・手で足した枠は m…） */
  id: string;
  /** 写真に対する比率（0〜1）。左上と大きさ */
  x: number;
  y: number;
  w: number;
  h: number;
  source: 'auto' | 'manual';
  /** true = 出す（隠さない）。見つけた顔も描いた枠も false で始まる */
  shown: boolean;
}

/** 写真 1 枚の顔の状態（画面へ返す形）。 */
export interface PhotoFaceState {
  /** kakera-photos の key */
  key: string;
  /** 顔の検出が済んでいるか（顔が 0 件でも済んでいれば true） */
  scanned: boolean;
  faces: PhotoFace[];
  /** 隠す枠の指紋。隠す枠が無ければ null（原本をそのまま出す） */
  fp: string | null;
  /** いまの指紋に合うモザイク済みの版が非公開バケットにあるか */
  masked: boolean;
}

/** 検出に使ったモデルの名前（photo_face_scan.model に残す）。変えるときは版を上げる。 */
export const FACE_MODEL = 'mediapipe-tasks-vision@0.10.35/blaze_face_full_range/float16/1@0.4+tile1024,384';

/** 写真 1 枚に持てる枠の数の上限（拾いすぎても困らない程度に大きく）。 */
export const MAX_FACES = 200;

/** モザイクのかけ方（§3.3）。変えたら指紋の版も上げる（古い版を作り直させる）。 */
export const MOSAIC = {
  /** 枠を上下左右に広げる割合 */
  expand: 0.2,
  /** ブロックの大きさ = 顔の幅（px）÷ これ */
  blockDiv: 8,
  /** ブロックの最小（px） */
  minBlock: 8,
  version: 'v1',
} as const;

/** 顔の検出・モザイクをかける写真か（かけらに貼った写真だけ。リンクカードの画像 kakera/cards/… は対象外）。 */
export function isFacePhotoKey(key: string): boolean {
  return /^kakera\/\d{4}\/\d{2}\/[A-Za-z0-9_.-]+$/.test(key) && !key.includes('..');
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 比率の枠を、写真の内側に収めて小数 4 桁に丸める。小さすぎる・はみ出しきった枠は null。 */
export function normalizeBox(b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
  if (![b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n))) return null;
  const x0 = clamp01(b.x);
  const y0 = clamp01(b.y);
  const x1 = clamp01(b.x + b.w);
  const y1 = clamp01(b.y + b.h);
  const x = round4(x0);
  const y = round4(y0);
  const w = round4(x1 - x0);
  const h = round4(y1 - y0);
  if (w < 0.002 || h < 0.002) return null;
  return { x, y, w, h };
}

/** 画面・API から届いた枠を形だけ検める。形が違えば null（どれか一つでも崩れていたら全体を受け付けない）。 */
export function parseFaces(raw: unknown): PhotoFace[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FACES) return null;
  const out: PhotoFace[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || !/^[am][A-Za-z0-9-]{0,40}$/.test(o.id) || seen.has(o.id)) return null;
    if (o.source !== 'auto' && o.source !== 'manual') return null;
    if (typeof o.shown !== 'boolean') return null;
    const box = normalizeBox({ x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h) });
    if (!box) return null;
    seen.add(o.id);
    out.push({ id: o.id, ...box, source: o.source, shown: o.shown });
  }
  return out;
}

/** 隠す枠（出すにした枠を除く）。 */
export function hiddenFaces(faces: PhotoFace[]): PhotoFace[] {
  return faces.filter((f) => !f.shown);
}

/**
 * 隠す枠の指紋（SHA-256 の先頭 8 桁）。隠す枠が無ければ null。
 * 並び順・出す枠・id の振り方には左右されない（隠す範囲が同じなら同じ指紋）。
 */
export async function faceFingerprint(faces: PhotoFace[]): Promise<string | null> {
  const hidden = hiddenFaces(faces)
    .map((f) => [f.x, f.y, f.w, f.h].map((n) => round4(n).toFixed(4)).join(','))
    .sort();
  if (!hidden.length) return null;
  const text = `${MOSAIC.version}|${hidden.join('|')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isFingerprint(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}$/.test(s);
}

/** 拡張子を除いた名前と拡張子（kakera/2026/10/12_1432_<ULID>_1.jpg → 2026/10/12_1432_<ULID>_1 と jpg）。 */
function splitKey(key: string): { stem: string; ext: string } {
  const rest = key.replace(/^kakera\//, '');
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(rest);
  return m ? { stem: m[1]!, ext: m[2]! } : { stem: rest, ext: '' };
}

/**
 * モザイク済みの版の名前の頭。JPEG の写真は `<名前>`、それ以外は `<名前>.<拡張子>`。
 * 同じかけらの同じ番号に `_1.png` と `_1.jpg` があっても、版も公開 key も混ざらない（2026-10-12 再レビューで変更）。
 * JPEG を拡張子なしにしているのは、先に決めた公開 key の形（`diary/<名前>.m-<指紋>.jpg`）を変えないため。
 */
function maskedHead(key: string): string {
  const { stem, ext } = splitKey(key);
  return ext.toLowerCase() === 'jpg' || ext === '' ? stem : `${stem}.${ext}`;
}

/** モザイク済みの版の key（非公開バケット）。例: kakera/masked/2026/10/12_1432_<ULID>_1.<指紋>.jpg */
export function maskedKeyFor(key: string, fp: string): string {
  return `kakera/masked/${maskedHead(key)}.${fp}.jpg`;
}

/**
 * モザイク済みの版の公開 key。指紋を入れる（例: diary/2026/10/12_1432_<ULID>_1.m-<指紋>.jpg・
 * PNG の写真なら diary/…_1.png.m-<指紋>.jpg）。
 * ⚠️ 同じ key を上書きすると、CDN に素顔の版が残って見え続けるおそれがある。だから枠を直すたびに key を変える。
 */
export function maskedPublicKeyFor(key: string, fp: string): string {
  return `diary/${maskedHead(key)}.m-${fp}.jpg`;
}

/**
 * 公開バケットを一覧するときの前方一致（その写真の公開 key を全部含む。別の拡張子の同じ番号も含みうるので、
 * 一覧の後は isPublicKeyOf で絞る）。末尾の `.` まで含めるので、`_1.` が `_10.` を拾うことはない。
 */
export function publicPrefixFor(key: string): string {
  return `diary/${splitKey(key).stem}.`;
}

/**
 * 公開バケットの key が、その写真の公開 key（素顔の版 `diary/<名前>.<拡張子>`、
 * またはモザイクの版 `diary/<名前>[.<拡張子>].m-<指紋>.jpg`）か。拡張子が違う別の写真の key は含まない。
 */
export function isPublicKeyOf(key: string, publicKey: string): boolean {
  const { stem, ext } = splitKey(key);
  if (ext && publicKey === `diary/${stem}.${ext}`) return true;
  const m = /^\.m-[0-9a-f]{8}\.jpg$/;
  const head = `diary/${maskedHead(key)}`;
  return publicKey.startsWith(head) && m.test(publicKey.slice(head.length));
}

/* ---------------- モザイクの範囲 ---------------- */

/** 描いた canvas の大きさ（px。長辺 4096px・16MP 以下に縮めたもの）でモザイクをかける四角とブロックの大きさ（§3.3: 枠を 20% 広げる・ブロックは顔の幅の 1/8、最小 8px）。 */
export function mosaicRect(f: { x: number; y: number; w: number; h: number }, width: number, height: number): {
  x: number;
  y: number;
  w: number;
  h: number;
  block: number;
} {
  const fw = f.w * width;
  const fh = f.h * height;
  const x0 = Math.max(0, Math.floor(f.x * width - fw * MOSAIC.expand));
  const y0 = Math.max(0, Math.floor(f.y * height - fh * MOSAIC.expand));
  const x1 = Math.min(width, Math.ceil(f.x * width + fw * (1 + MOSAIC.expand)));
  const y1 = Math.min(height, Math.ceil(f.y * height + fh * (1 + MOSAIC.expand)));
  const block = Math.max(MOSAIC.minBlock, Math.round(fw / MOSAIC.blockDiv));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), block };
}

/**
 * RGBA の画素列の四角い範囲を、ブロックごとの平均色で塗りつぶす（その場で書き換える）。
 * ぼかしではなくモザイクにして、元に戻せない粗さを保つ（§3.3）。
 */
export function pixelate(
  data: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; w: number; h: number; block: number }
): void {
  const { block } = rect;
  for (let by = rect.y; by < rect.y + rect.h; by += block) {
    for (let bx = rect.x; bx < rect.x + rect.w; bx += block) {
      const ex = Math.min(bx + block, rect.x + rect.w);
      const ey = Math.min(by + block, rect.y + rect.h);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          a += data[i + 3]!;
          n++;
        }
      }
      if (!n) continue;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      a = Math.round(a / n);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = a;
        }
      }
    }
  }
}

/* ---------------- JPEG の検め ---------------- */

/** JPEG か（先頭が SOI）。 */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * JPEG に EXIF（APP1 の "Exif\0\0"）が載っているか。SOS（画素の始まり）までの区画だけ見る。
 * 作り直した JPEG に EXIF を載せない（§3.3）ので、載っていたら受け取らない。
 */
export function hasExif(bytes: Uint8Array): boolean {
  if (!isJpeg(bytes)) return false;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return false; // 区画の頭が崩れている（ここから先は読まない）
    const marker = bytes[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) return false; // EOI・SOS
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker === 0xe1 && len >= 8) {
      const s = String.fromCharCode(...bytes.slice(i + 4, i + 10));
      if (s === 'Exif\0\0') return true;
    }
    i += 2 + len;
  }
  return false;
}

/* ---------------- 検出した枠のまとめ ---------------- */

/** 比率の枠の重なり（IoU）。 */
export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 写真全体と切り分けた区画の両方で検出した枠を一つにまとめる。
 * 重なる枠（IoU 0.3 以上、または小さい方の 6 割以上が大きい方に入る）は、確からしさの高い方を残す。
 * 残った枠に a1, a2, … の id を振り、全部「隠す」で始める。
 */
export function mergeDetections(found: { x: number; y: number; w: number; h: number; score: number }[]): PhotoFace[] {
  const sorted = found
    .map((f) => ({ ...f, box: normalizeBox(f) }))
    .filter((f): f is typeof f & { box: NonNullable<typeof f.box> } => !!f.box)
    .sort((a, b) => b.score - a.score);
  const kept: (typeof sorted)[number][] = [];
  for (const f of sorted) {
    const dup = kept.some((k) => {
      if (iou(k.box, f.box) >= 0.3) return true;
      const ix = Math.max(0, Math.min(k.box.x + k.box.w, f.box.x + f.box.w) - Math.max(k.box.x, f.box.x));
      const iy = Math.max(0, Math.min(k.box.y + k.box.h, f.box.y + f.box.h) - Math.max(k.box.y, f.box.y));
      const small = Math.min(k.box.w * k.box.h, f.box.w * f.box.h);
      return small > 0 && (ix * iy) / small >= 0.6;
    });
    if (!dup) kept.push(f);
  }
  return kept
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
    .slice(0, MAX_FACES)
    .map((f, i) => ({ id: `a${i + 1}`, ...f.box, source: 'auto' as const, shown: false }));
}

/* ---------------- 検出・モザイクに使う canvas の大きさと区画（2026-10-12 レビューで追加） ---------------- */

/**
 * canvas の上限。iOS Safari は面積が大きすぎる canvas を**黙って空のまま**にする（24MP の原寸を描くと真っ黒・透明）。
 * 空の canvas で検出すると「顔 0 件 → 調べ済み → 素顔の原本が公開」になりうるので、必ずこの内側に縮めて描く。
 */
export const CANVAS_LIMIT = { maxEdge: 4096, maxArea: 16_000_000 } as const;

/** 写真を検出・モザイクに使う canvas の大きさ（長辺 4096px かつ面積 16MP 以下。大きくはしない）。 */
export function fitCanvasSize(
  width: number,
  height: number,
  limit: { maxEdge: number; maxArea: number } = CANVAS_LIMIT
): { width: number; height: number; scale: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0, scale: 0 };
  const scale = Math.min(1, limit.maxEdge / Math.max(width, height), Math.sqrt(limit.maxArea / (width * height)));
  // 丸めで上限を越えないよう切り捨てる
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  while (w * h > limit.maxArea) {
    w = Math.max(1, w - 1);
    h = Math.max(1, Math.floor((w * height) / width));
  }
  return { width: w, height: h, scale: w / width };
}

/** 空の canvas か見る場所（縦横 3×3 の 9 か所・各 4×4px）。 */
export function blankProbePoints(width: number, height: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const pw = Math.min(4, width);
  const ph = Math.min(4, height);
  for (const fy of [0.2, 0.5, 0.8]) {
    for (const fx of [0.2, 0.5, 0.8]) {
      out.push({
        x: Math.min(width - pw, Math.max(0, Math.floor(width * fx))),
        y: Math.min(height - ph, Math.max(0, Math.floor(height * fy))),
        w: pw,
        h: ph,
      });
    }
  }
  return out;
}

/**
 * 見た場所の画素（RGBA）が全部透明（または全部 0）なら、描けていない canvas とみなす。
 * JPEG を描いた canvas は不透明になるので、写真が真っ黒でもアルファは 255 で、ここには掛からない。
 */
export function looksBlank(samples: Uint8ClampedArray[]): boolean {
  if (!samples.length) return true;
  return samples.every((d) => {
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  });
}

/**
 * タイル検出の区画の大きさ（2026-10-12 レビューで追加）。full range モデルの入力は 192px なので、
 * 遠景・集合写真の小さい顔は写真全体の 1 回では拾えない。
 * 1024px の区画だけでは、長辺 4096px の写真で幅 40px 前後の顔をほぼ拾えなかった（dev で 33 人中 1 人）。
 * 384px の区画を足すと 33 人中 31 人前後まで拾えたので、二段にする（拾いすぎに倒す）。
 */
export const FACE_TILE_SIZES = [1024, 384] as const;

/**
 * タイル検出の区画。大きさごとに 2 割重ねて端まで並べる（端の 1 枚だけは重なりが 1〜3 割になることがある）。写真がその大きさ以下なら、その段は作らない
 * （写真全体の 1 回で足りる）。重なって二重に拾った枠は mergeDetections が IoU でまとめる。
 */
export function faceTiles(
  width: number,
  height: number,
  sizes: readonly number[] = FACE_TILE_SIZES,
  overlap = 0.2
): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const tile of sizes) {
    if (Math.max(width, height) <= tile) continue;
    const along = (len: number): [number, number][] => {
      const size = Math.min(tile, len);
      if (size >= len) return [[0, len]];
      const step = Math.max(1, Math.floor(size * (1 - overlap)));
      const starts: number[] = [];
      for (let s = 0; s + size < len; s += step) starts.push(s);
      // 最後は端に揃える。直前の区画と 9 割以上重なるなら、直前の区画を端に寄せて 1 枚にする（間引き。
      // 寄せた後も一つ前とは 1 割以上重なり、端まで覆う・2026-10-12 再レビューで追加）
      const end = len - size;
      const last = starts[starts.length - 1]!;
      if (starts.length > 1 && end - last < size * 0.1) starts[starts.length - 1] = end;
      else starts.push(end);
      return [...new Set(starts)].map((s) => [s, size]);
    };
    for (const [y, h] of along(height)) for (const [x, w] of along(width)) out.push({ x, y, w, h });
  }
  return out;
}
