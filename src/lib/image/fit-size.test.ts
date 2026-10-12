import { describe, expect, it } from 'vitest';
import { aspectOf, fitSize, fitUploadSize, IOS_CANVAS_MAX_AREA, UPLOAD_LIMIT } from './fit-size';

describe('アップロード時の縮小（2026-10-12 縦長画像で長辺の上限から面積の上限へ）', () => {
  it('普通の写真 4032×3024 は面積 ≤ 2048×2048 に縮める（縦横比を保つ）', () => {
    const r = fitUploadSize(4032, 3024);
    expect(r).toMatchObject({ width: 2364, height: 1773 });
    expect(r.width * r.height).toBeLessThanOrEqual(2048 * 2048);
    expect(fitUploadSize(3024, 4032)).toMatchObject({ width: 1773, height: 2364 });
    expect(fitUploadSize(4000, 4000)).toMatchObject({ width: 2048, height: 2048 });
  });

  it('横長: 縦横比 2 以下は面積 4.2MP、2 を超えたら横長でも長い辺を保つ', () => {
    expect(fitUploadSize(4032, 2268)).toMatchObject({ width: 2730, height: 1536 }); // 16:9
    expect(fitUploadSize(2896, 1448)).toMatchObject({ width: 2896, height: 1448, scale: 1 }); // ちょうど 2:1・上限内
    expect(fitUploadSize(6000, 2000)).toMatchObject({ width: 6000, height: 2000, scale: 1 }); // 3:1・12MP ちょうど
    const pano = fitUploadSize(12000, 3000); // 4:1・36MP
    expect(pano.width * pano.height).toBeLessThanOrEqual(12_000_000);
    expect(pano).toMatchObject({ width: 6928, height: 1732 });
  });

  it('縦横比 1:15 のスクリーンショット 1290×19350 は 12MP まで（以前は 95×2048）', () => {
    const r = fitUploadSize(1290, 19350);
    expect(r).toMatchObject({ width: 894, height: 13416 });
    expect(r.width * r.height).toBeLessThanOrEqual(UPLOAD_LIMIT.long.maxArea);
    expect(Math.abs(r.height / r.width - 15)).toBeLessThan(0.02);
  });

  it('細長くても 12MP 以内なら横幅を保つ（縮めない）。iPhone のスクリーンショットもそのまま', () => {
    expect(fitUploadSize(1290, 9000)).toEqual({ width: 1290, height: 9000, scale: 1 });
    expect(fitUploadSize(1290, 2796)).toEqual({ width: 1290, height: 2796, scale: 1 });
    expect(fitUploadSize(800, 600)).toEqual({ width: 800, height: 600, scale: 1 }); // 拡大しない
  });

  it('長辺は 16384px を越えない（細すぎる画像）', () => {
    expect(fitUploadSize(400, 30000)).toMatchObject({ width: 218, height: 16384 });
  });

  it('iOS の canvas の上限ぎりぎり: どの入力でも出力は 16,777,216px 未満', () => {
    const cases: [number, number][] = [
      [4096, 4096], // ちょうど iOS の上限の正方形
      [4097, 4095],
      [1366, 12288], // 細長い・iOS の上限をわずかに越える（16,785,408px）
      [1365, 12291], // iOS の上限のわずかに内側（16,777,215px）
      [16384, 1024],
      [1024, 16384],
      [8000, 8000],
      [30000, 30000],
    ];
    for (const [w, h] of cases) {
      const r = fitUploadSize(w, h);
      expect(r.width * r.height).toBeLessThan(IOS_CANVAS_MAX_AREA);
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(16_384);
      expect(r.width).toBeLessThanOrEqual(w);
      expect(r.height).toBeLessThanOrEqual(h);
    }
    expect(fitUploadSize(4096, 4096)).toMatchObject({ width: 2048, height: 2048 });
    expect(fitUploadSize(1024, 16384)).toMatchObject({ width: 866, height: 13856 });
    expect(UPLOAD_LIMIT.long.maxArea).toBeLessThan(IOS_CANVAS_MAX_AREA);
    expect(UPLOAD_LIMIT.normal.maxArea).toBeLessThan(IOS_CANVAS_MAX_AREA);
  });

  it('大きさが読めなければ 0×0（呼んだ側が原本を送る）', () => {
    expect(fitUploadSize(0, 100)).toEqual({ width: 0, height: 0, scale: 0 });
    expect(fitUploadSize(NaN, 100).width).toBe(0);
    expect(aspectOf(0, 1)).toBe(0);
  });

  it('fitSize: 丸めで上限を越えない', () => {
    for (const [w, h] of [[4033, 3025], [1291, 19351], [999, 17001], [7, 100000]] as const) {
      const r = fitSize(w, h, { maxEdge: 16_384, maxArea: 12_000_000 });
      expect(r.width * r.height).toBeLessThanOrEqual(12_000_000);
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(16_384);
      expect(r.width).toBeGreaterThanOrEqual(1);
      expect(r.height).toBeGreaterThanOrEqual(1);
    }
  });
});
