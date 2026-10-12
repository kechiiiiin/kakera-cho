// 顔モザイクの決まり（顔モザイク設計 §3.2〜§3.4）のうち、画面にもサーバにも依らない部分。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FACE_MODEL,
  faceFingerprint,
  hasExif,
  isFacePhotoKey,
  maskedKeyFor,
  maskedPublicKeyFor,
  mergeDetections,
  mosaicRect,
  parseFaces,
  pixelate,
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
