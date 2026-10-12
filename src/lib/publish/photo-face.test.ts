// 顔モザイクの決まり（顔モザイク設計 §3.2〜§3.4）のうち、画面にもサーバにも依らない部分。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FACE_MODEL,
  blankProbePoints,
  faceFingerprint,
  faceTiles,
  fitCanvasSize,
  looksBlank,
  hasExif,
  isFacePhotoKey,
  maskedKeyFor,
  maskedPublicKeyFor,
  mergeDetections,
  mosaicRect,
  parseFaces,
  pixelate,
  isPublicKeyOf,
  publicPrefixFor,
  type PhotoFace,
} from './photo-face';
import { publicKeyFor } from './photos';

const KEY = 'kakera/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.jpg';
const face = (id: string, x: number, shown = false, source: 'auto' | 'manual' = 'auto'): PhotoFace => ({
  id,
  x,
  y: 0.1,
  w: 0.2,
  h: 0.25,
  source,
  shown,
});

describe('顔モザイクの決まり', () => {
  it('検出モデルの版は package.json の @mediapipe/tasks-vision と同じ（固定）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const v = pkg.dependencies['@mediapipe/tasks-vision'];
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(FACE_MODEL).toContain(`tasks-vision@${v}/`);
    expect(FACE_MODEL).toContain('full_range');
    const faces = readFileSync(new URL('../../components/faces.ts', import.meta.url), 'utf8');
    expect(faces).toContain(`const MP_VERSION = '${v}'`);
  });

  it('対象はかけらに貼った写真だけ（リンクカードの画像は外す）', () => {
    expect(isFacePhotoKey(KEY)).toBe(true);
    expect(isFacePhotoKey('kakera/cards/abc.png')).toBe(false);
    expect(isFacePhotoKey('kakera/masked/2026/10/a.12345678.jpg')).toBe(false);
    expect(isFacePhotoKey('kakera/2026/10/../x.jpg')).toBe(false);
  });

  it('指紋: 隠す枠だけで決まる。並び・出す枠・id には左右されない。枠を直せば変わる', async () => {
    const a = [face('a1', 0.1), face('a2', 0.5), face('a3', 0.7, true)];
    const b = [face('m9', 0.5, false, 'manual'), face('a1', 0.1)];
    const fa = await faceFingerprint(a);
    expect(fa).toMatch(/^[0-9a-f]{8}$/);
    expect(await faceFingerprint(b)).toBe(fa);
    expect(await faceFingerprint([face('a1', 0.1), face('a2', 0.51)])).not.toBe(fa);
    expect(await faceFingerprint([face('a1', 0.1, true)])).toBeNull();
    expect(await faceFingerprint([])).toBeNull();
  });

  it('key: モザイク済みの版も公開 key も指紋入り。古い公開 key は同じ前方一致で拾える', () => {
    expect(maskedKeyFor(KEY, 'abcd1234')).toBe('kakera/masked/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.abcd1234.jpg');
    const pub = maskedPublicKeyFor(KEY, 'abcd1234');
    expect(pub).toBe('diary/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.m-abcd1234.jpg');
    const prefix = publicPrefixFor(KEY);
    expect(pub.startsWith(prefix)).toBe(true);
    expect(publicKeyFor(KEY).startsWith(prefix)).toBe(true);
    // _1 の前方一致が _10 を拾わない
    expect(publicKeyFor(KEY.replace('_1.jpg', '_10.jpg')).startsWith(prefix)).toBe(false);
  });

  it('key: 拡張子ごとに分かれる。_1.jpg と _1.png の版・公開 key は混ざらない（2026-10-12 再レビュー）', () => {
    const PNG = KEY.replace('.jpg', '.png');
    expect(maskedKeyFor(PNG, 'abcd1234')).toBe('kakera/masked/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.png.abcd1234.jpg');
    expect(maskedPublicKeyFor(PNG, 'abcd1234')).toBe('diary/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.png.m-abcd1234.jpg');
    expect(maskedKeyFor(PNG, 'abcd1234')).not.toBe(maskedKeyFor(KEY, 'abcd1234'));

    const jpgPlain = publicKeyFor(KEY); // diary/<名前>.jpg
    const jpgMasked = maskedPublicKeyFor(KEY, 'abcd1234'); // diary/<名前>.m-<指紋>.jpg
    const pngPlain = publicKeyFor(PNG);
    const pngMasked = maskedPublicKeyFor(PNG, 'ffff0000');
    // その写真の公開 key（素顔・モザイクの両方の形）を拾い、拡張子の違う写真の key は拾わない
    expect(isPublicKeyOf(KEY, jpgPlain)).toBe(true);
    expect(isPublicKeyOf(KEY, jpgMasked)).toBe(true);
    expect(isPublicKeyOf(KEY, pngPlain)).toBe(false);
    expect(isPublicKeyOf(KEY, pngMasked)).toBe(false);
    expect(isPublicKeyOf(PNG, pngPlain)).toBe(true);
    expect(isPublicKeyOf(PNG, pngMasked)).toBe(true);
    expect(isPublicKeyOf(PNG, jpgPlain)).toBe(false);
    expect(isPublicKeyOf(PNG, jpgMasked)).toBe(false);
    // 一覧の前方一致には両方が入る（一覧の後で isPublicKeyOf で絞る）
    for (const k of [jpgPlain, jpgMasked, pngPlain, pngMasked]) expect(k.startsWith(publicPrefixFor(KEY))).toBe(true);
    // _10 や形の違う key は拾わない
    expect(isPublicKeyOf(KEY, publicKeyFor(KEY.replace('_1.jpg', '_10.jpg')))).toBe(false);
    expect(isPublicKeyOf(KEY, jpgMasked.replace('.jpg', '.png'))).toBe(false);
  });

  it('届いた枠を検める: 0〜1 に収めて丸める。形が崩れていたら全体を受け付けない', () => {
    const ok = parseFaces([{ id: 'a1', x: -0.1, y: 0.123456, w: 0.5, h: 2, source: 'auto', shown: false }]);
    expect(ok).toEqual([{ id: 'a1', x: 0, y: 0.1235, w: 0.4, h: 0.8765, source: 'auto', shown: false }]);
    expect(parseFaces([{ id: 'x1', x: 0, y: 0, w: 0.1, h: 0.1, source: 'auto', shown: false }])).toBeNull();
    expect(parseFaces([{ id: 'a1', x: 0, y: 0, w: 0.1, h: 0.1, source: 'auto', shown: 'no' }])).toBeNull();
    expect(parseFaces([{ id: 'a1', x: 0, y: 0, w: 0, h: 0.1, source: 'auto', shown: false }])).toBeNull();
    expect(
      parseFaces([
        { id: 'a1', x: 0, y: 0, w: 0.1, h: 0.1, source: 'auto', shown: false },
        { id: 'a1', x: 0.5, y: 0, w: 0.1, h: 0.1, source: 'auto', shown: false },
      ])
    ).toBeNull();
    expect(parseFaces('x')).toBeNull();
    expect(parseFaces([])).toEqual([]);
  });

  it('検出のまとめ: 重なる枠は確からしい方を残し、全部「隠す」で始まる', () => {
    const merged = mergeDetections([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.6 },
      { x: 0.11, y: 0.1, w: 0.2, h: 0.2, score: 0.9 },
      { x: 0.12, y: 0.12, w: 0.05, h: 0.05, score: 0.5 }, // 大きい枠の中に収まる
      { x: 0.6, y: 0.5, w: 0.1, h: 0.1, score: 0.45 },
    ]);
    expect(merged.map((f) => [f.id, f.x, f.shown, f.source])).toEqual([
      ['a1', 0.11, false, 'auto'],
      ['a2', 0.6, false, 'auto'],
    ]);
  });

  it('モザイクの範囲: 枠を 20% 広げ、ブロックは顔の幅の 1/8（最小 8px）。写真からはみ出さない', () => {
    const r = mosaicRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 800);
    expect(r).toEqual({ x: 150, y: 120, w: 700, h: 560, block: 63 });
    const small = mosaicRect({ x: 0, y: 0.9, w: 0.02, h: 0.2 }, 1000, 800);
    expect(small.x).toBe(0);
    expect(small.y + small.h).toBeLessThanOrEqual(800);
    expect(small.block).toBe(8);
  });

  it('モザイク: ブロックの中は一色になる（元の画素は残らない）', () => {
    const W = 16;
    const data = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < W * W; i++) data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
    pixelate(data, W, { x: 0, y: 0, w: 8, h: 8, block: 8 });
    const first = [...data.slice(0, 4)];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect([...data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)]).toEqual(first);
    // 範囲の外は触らない
    expect([...data.slice(8 * 4, 8 * 4 + 4)]).toEqual([8, 56, 104, 255]);
  });

  it('EXIF: APP1 の Exif を見つける。JFIF だけなら無い', () => {
    const jfif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...'JFIF\0'.split('').map((c) => c.charCodeAt(0)), ...new Array(9).fill(0), 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    expect(hasExif(jfif)).toBe(false);
    const exif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0e, ...'Exif\0\0'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0xff, 0xda, 0, 2]);
    expect(hasExif(exif)).toBe(true);
  });
});

describe('検出・モザイクに使う canvas と区画（2026-10-12 レビュー）', () => {
  it('縮小: 面積 16MP 以下・長辺 4096px（縦横比 2 超は 16384px）以下。小さい写真は大きくしない', () => {
    const big = fitCanvasSize(6000, 4000); // 24MP
    expect(big.width).toBeLessThanOrEqual(4096);
    expect(big.width * big.height).toBeLessThanOrEqual(16_000_000);
    expect(Math.abs(big.width / big.height - 1.5)).toBeLessThan(0.01);
    const narrow = fitCanvasSize(3000, 5000); // 縦横比 2 以下は長辺 4096px で効く
    expect(narrow.height).toBe(4096);
    expect(narrow.width).toBe(2457);
    // 縦横比 2 超は長辺を 16384px まで緩め、面積で効く（2026-10-12 縦長画像で変更。以前は 1365×4096）
    const tall = fitCanvasSize(3000, 9000);
    expect(tall).toMatchObject({ width: 2309, height: 6928 });
    expect(tall.width * tall.height).toBeLessThanOrEqual(16_000_000);
    // 1:15 のスクリーンショット（以前は 273×4096）
    const shot = fitCanvasSize(1290, 19350);
    expect(shot).toMatchObject({ width: 1032, height: 15491 });
    expect(shot.width * shot.height).toBeLessThanOrEqual(16_000_000);
    // 面積が小さくても長辺 16384px は越えない
    expect(fitCanvasSize(400, 30000)).toMatchObject({ width: 218, height: 16384 });
    // 上限を明示して渡したときはそれをそのまま使う
    expect(fitCanvasSize(3000, 9000, { maxEdge: 4096, maxArea: 16_000_000 })).toMatchObject({ width: 1365, height: 4096 });
    const square = fitCanvasSize(4096, 4096); // 面積で効く
    expect(square.width * square.height).toBeLessThanOrEqual(16_000_000);
    expect(square.width).toBe(4000);
    expect(fitCanvasSize(2048, 1536)).toEqual({ width: 2048, height: 1536, scale: 1 });
    expect(fitCanvasSize(0, 100).width).toBe(0);
  });

  it('空の canvas: 見た場所が全部透明なら空。真っ黒でも不透明なら空ではない', () => {
    const transparent = new Uint8ClampedArray(4 * 16);
    const black = new Uint8ClampedArray(4 * 16);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    expect(looksBlank([transparent, transparent])).toBe(true);
    expect(looksBlank([transparent, black])).toBe(false);
    expect(looksBlank([])).toBe(true);
    const pts = blankProbePoints(100, 50);
    expect(pts).toHaveLength(9);
    for (const p of pts) {
      expect(p.x + p.w).toBeLessThanOrEqual(100);
      expect(p.y + p.h).toBeLessThanOrEqual(50);
    }
    expect(blankProbePoints(2, 2).every((p) => p.w === 2 && p.h === 2 && p.x === 0 && p.y === 0)).toBe(true);
  });

  it('区画: 1024px と 384px の二段。写真がその大きさ以下ならその段は作らない。重ねて端まで覆う', () => {
    expect(faceTiles(384, 300)).toEqual([]);
    expect(faceTiles(1024, 768).every((t) => t.w === 384)).toBe(true);
    const tiles = faceTiles(4096, 2731);
    const big = tiles.filter((t) => t.w === 1024);
    // 横: 0, 819, 1638, 2457, 3072（端に揃える）／縦: 0, 819, 1707（1638 と 1707 は 9 割以上重なるので 1 枚に間引く）
    expect(new Set(big.map((t) => t.x))).toEqual(new Set([0, 819, 1638, 2457, 3072]));
    expect(new Set(big.map((t) => t.y))).toEqual(new Set([0, 819, 1707]));
    expect(big).toHaveLength(15);
    const small = tiles.filter((t) => t.w === 384);
    expect(small.length).toBe(tiles.length - 15);
    for (const size of [1024, 384]) {
      const same = tiles.filter((t) => t.w === size);
      for (const t of same) {
        expect(t.h).toBe(size);
        expect(t.x + t.w).toBeLessThanOrEqual(4096);
        expect(t.y + t.h).toBeLessThanOrEqual(2731);
      }
      // 端まで覆う・隣り合う区画は 1 割以上（端以外は 2 割）重なり、9 割以上重なる区画は無い
      for (const [axis, len] of [['x', 4096], ['y', 2731]] as const) {
        const ps = [...new Set(same.map((t) => t[axis]))].sort((a, b) => a - b);
        expect(ps[0]).toBe(0);
        expect(ps[ps.length - 1]! + size).toBe(len);
        for (let i = 1; i < ps.length; i++) {
          const ov = ps[i - 1]! + size - ps[i]!;
          expect(ov).toBeGreaterThanOrEqual(Math.floor(size * 0.1));
          if (i < ps.length - 1) expect(ov).toBeGreaterThanOrEqual(Math.floor(size * 0.2));
          expect(ov).toBeLessThan(size * 0.9);
        }
      }
    }
    // 4032×3024（iPhone の写真）
    const iphone = faceTiles(4032, 3024);
    expect(iphone.filter((t) => t.w === 1024).length).toBeGreaterThan(0);
    expect(iphone.length).toBeLessThan(200);
    // 細長い写真は短い辺を 1 区画のまま（1024 の段）
    const thin = faceTiles(3000, 600, [1024]);
    expect(thin.every((t) => t.y === 0 && t.h === 600)).toBe(true);
  });

  it('区画: 縦長の画像でも区画数は普通の写真と同じ桁に収まる（2026-10-12 縦長画像）', () => {
    // 面積を 16MP に抑えているので、区画数は面積にほぼ比例して頭打ちになる（普通の写真 4032×3024 で 150）
    const count = (w: number, h: number) => {
      const c = fitCanvasSize(w, h);
      return faceTiles(c.width, c.height).length;
    };
    expect(count(4032, 3024)).toBe(150);
    expect(count(1290, 19350)).toBe(191); // 1032×15491
    expect(count(1290, 19000)).toBe(238); // 1042×15351（384 の段が横 4 列になる）
    expect(count(894, 13416)).toBe(149); // アップロード時に縮めた 1290×19350
    for (const [w, h] of [[1290, 19350], [1290, 19000], [1000, 16000], [400, 30000], [3000, 6200], [3000, 9000], [4000, 4000]] as const) {
      expect(count(w, h)).toBeLessThanOrEqual(260);
    }
    // 縦長でも区画は画像の内側で、端まで覆う
    const c = fitCanvasSize(1290, 19350);
    const tiles = faceTiles(c.width, c.height);
    for (const t of tiles) {
      expect(t.x + t.w).toBeLessThanOrEqual(c.width);
      expect(t.y + t.h).toBeLessThanOrEqual(c.height);
    }
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBe(c.height);
  });

  it('区画ごとの検出をまとめる: 区画の重なりで二重に拾った顔は一つになり、離れた小さい顔は全部残る', () => {
    const W = 4096;
    const H = 2731;
    // 同じ顔を全体と 2 つの区画で拾った（座標が少しずれる）＋ 小さい顔 3 つ
    const px = (x: number, y: number, w: number, h: number, score: number) => ({ x: x / W, y: y / H, w: w / W, h: h / H, score });
    const merged = mergeDetections([
      px(900, 500, 120, 140, 0.7),
      px(902, 503, 118, 138, 0.9),
      px(898, 498, 121, 141, 0.5),
      px(200, 2000, 40, 48, 0.45),
      px(2500, 300, 36, 42, 0.42),
      px(3900, 2600, 30, 36, 0.41),
    ]);
    expect(merged).toHaveLength(4);
    expect(merged.every((f) => !f.shown && f.source === 'auto')).toBe(true);
  });
});
