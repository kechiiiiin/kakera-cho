// 画像を縮める大きさの計算（DOM に依存しない純粋関数。画面とテストの両方から使う）。
//
// 2026-10-12 縦長画像で変更: 「長辺の上限」だけで縮めると、縦横比 1:15 のスクリーンショット（1290×19350）が
// 95×2048 まで細くなり、日記で拡大しても読めなかった。上限は**画素数（面積）**で決め、
// 縦横比が 2 を超える細長い画像は横幅を保つ方を優先して面積の上限を広げる。

/**
 * iOS Safari の canvas の面積の上限（4096×4096 = 16,777,216 px）。越えると canvas は**黙って空のまま**になる。
 * どの縮小もこれを越える canvas を作らない。
 */
export const IOS_CANVAS_MAX_AREA = 16_777_216;

/** 縮める上限。maxEdge は長辺、maxArea は面積（px）。 */
export interface FitLimit {
  maxEdge: number;
  maxArea: number;
}

/** これを越える縦横比（長辺÷短辺）は「細長い画像」として扱う */
export const LONG_ASPECT = 2;

/** 縦横比（長辺÷短辺）。大きさが読めなければ 0。 */
export function aspectOf(width: number, height: number): number {
  if (!(width > 0 && height > 0)) return 0;
  return Math.max(width, height) / Math.min(width, height);
}

/**
 * 縦横比を保ったまま、長辺と面積の上限の内側に収める大きさ。大きくはしない（scale ≤ 1）。
 * 丸めで上限を越えないよう切り捨てる。大きさが読めなければ 0×0。
 */
export function fitSize(width: number, height: number, limit: FitLimit): { width: number; height: number; scale: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0, scale: 0 };
  const scale = Math.min(1, limit.maxEdge / Math.max(width, height), Math.sqrt(limit.maxArea / (width * height)));
  if (scale >= 1) return { width, height, scale: 1 };
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  while (w * h > limit.maxArea) {
    // 長い辺の方を 1px ずつ削り、もう一方は比で合わせる
    if (w >= h) {
      w = Math.max(1, w - 1);
      h = Math.max(1, Math.floor((w * height) / width));
    } else {
      h = Math.max(1, h - 1);
      w = Math.max(1, Math.floor((h * width) / height));
    }
  }
  return { width: w, height: h, scale: w / width };
}

/**
 * アップロード時の縮小の上限（photo.ts）。
 *  - 普通の写真（縦横比 2 以下）: 面積 ≤ 2048×2048（約 4.2MP）
 *  - 細長い画像（縦横比 2 超）: 面積 ≤ 12MP・長辺 ≤ 16384px（横幅を保つ方を優先。1290×12000 までは縮めない）
 * どちらも iOS の canvas の上限（約 16.7MP）の内側。
 */
export const UPLOAD_LIMIT = {
  normal: { maxEdge: 16_384, maxArea: 2048 * 2048 },
  long: { maxEdge: 16_384, maxArea: 12_000_000 },
} as const satisfies Record<string, FitLimit>;

/** アップロード前に縮める大きさ。元が上限内なら元のまま（scale = 1）。 */
export function fitUploadSize(width: number, height: number): { width: number; height: number; scale: number } {
  const limit = aspectOf(width, height) > LONG_ASPECT ? UPLOAD_LIMIT.long : UPLOAD_LIMIT.normal;
  return fitSize(width, height, limit);
}
