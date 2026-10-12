// 写真の顔の検出とモザイク（顔モザイク設計 §3.1・§3.3）。変換ページだけが使う。
//
//   - 検出はブラウザの中で行う（写真を外部へ送らない）。MediaPipe Tasks Vision の Face Detector（full range）
//   - 検出は変換ページで「顔を探す」を押したときだけ（2026-10-12 §2.1 で変更）。開いただけでは検出もモデルの読み込みもしない
//   - 検出モデルは**呼ばれたときに初めて読み込む**（import() で別の塊にする）。他の画面の重さは変わらない
//   - 版は固定（package.json の @mediapipe/tasks-vision と wasm・モデルの URL を揃える。photo-face.ts の FACE_MODEL）
//   - しきい値は 0.4。拾いすぎる側に倒す。full range でも入力は 192px に縮むので、
//     写真全体の 1 回に加えて、1024px と 384px の区画をそれぞれ 2 割重ねて検出し、重なった枠は IoU でまとめる（faceTiles）
//   - 写真は面積 16MP・長辺 4096px（縦横比 2 超の細長い画像は 16384px・2026-10-12 縦長画像で変更）以下に縮めた canvas に描き、
//     検出にもモザイクにも同じ大きさを使う（fitCanvasSize）。
//     iOS Safari は大きすぎる canvas を黙って空にするため。描けていない（空の）canvas なら検出できなかったことにする
//     （「顔は見つかりませんでした」と出さず、探せなかった理由を画面に出す。調べ済みの印も付けない）
//   - canvas から作り直した JPEG には EXIF が載らない

import type { FaceDetector } from '@mediapipe/tasks-vision';
import {
  blankProbePoints,
  faceTiles,
  fitCanvasSize,
  hiddenFaces,
  looksBlank,
  mergeDetections,
  mosaicRect,
  pixelate,
  type PhotoFace,
} from '../lib/publish/photo-face';
import { photoUrlFor } from '../lib/publish/photos';

const MP_VERSION = '0.10.35';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite';
const THRESHOLD = 0.4;

let detector: Promise<FaceDetector> | null = null;

function loadDetector(): Promise<FaceDetector> {
  if (!detector) {
    detector = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: THRESHOLD,
      });
    })();
    // 読み込みに失敗したら、次に呼ばれたときにやり直す
    detector.catch(() => {
      detector = null;
    });
  }
  return detector;
}

/**
 * 原本を読んで、向きを直し、上限（面積 16MP・長辺 4096px、細長い画像は 16384px）の内側に縮めた canvas にする。
 * ⚠️ <img> 経由で描く（今の Safari・Chrome は EXIF の向きを当てて描く）。画面に見えている向きと枠の位置を揃える。
 * ⚠️ 描けていない（空の）canvas なら投げる。空のまま検出すると「顔 0 件」になり、素顔の原本が出てしまう。
 */
export async function loadPhotoCanvas(key: string): Promise<HTMLCanvasElement> {
  const res = await fetch(photoUrlFor(key));
  if (!res.ok) throw new Error(`写真を読めませんでした（${res.status}）`);
  const url = URL.createObjectURL(await res.blob());
  let canvas: HTMLCanvasElement | null = null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = fitCanvasSize(img.naturalWidth, img.naturalHeight);
    if (!size.width || !size.height) throw new Error('写真の大きさが読めません');
    canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const cx = canvas.getContext('2d');
    if (!cx) throw new Error('canvas が使えません');
    // 白で下地を塗ってから描く（2026-10-12 再レビューで追加）。透明の PNG を「空の canvas」と取り違えず、
    // JPEG にしたとき透明が黒く抜けることもない。
    // ⚠️ 上限を越えて壊れた canvas には塗りも効かず透明のままなので、下の空の判定はそのまま効く。
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, size.width, size.height);
    cx.drawImage(img, 0, 0, size.width, size.height);
    const samples = blankProbePoints(size.width, size.height).map((p) => cx.getImageData(p.x, p.y, p.w, p.h).data);
    if (looksBlank(samples)) throw new Error('写真を描けませんでした（大きすぎる・読めない形式の可能性）');
    const out = canvas;
    canvas = null; // 呼んだ側へ渡す（ここでは縮めない）
    return out;
  } finally {
    if (canvas) releaseCanvas(canvas);
    URL.revokeObjectURL(url);
  }
}

/** iOS Safari は canvas の合計の大きさにも上限がある。使い終わった canvas はすぐ縮めて返す。 */
function releaseCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

/** 手を戻す（区画の検出の合間に、画面の描画とタップを通す）。 */
const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r));

/** これだけ区画を調べるごとに手を戻す */
const YIELD_EVERY = 4;

/**
 * 写真の顔を探す。見つけた枠は全部「隠す」で返す（0 件もありうる）。描けなかった写真は投げる（調べ済みにしない）。
 * 区画を数枚調べるごとに手を戻す（メインスレッドを止めない）。onProgress で区画の進み具合を知らせる。
 */
export async function detectFaces(key: string, onProgress?: (done: number, total: number) => void): Promise<PhotoFace[]> {
  const [detR, canvasR] = await Promise.allSettled([loadDetector(), loadPhotoCanvas(key)]);
  if (canvasR.status === 'rejected') throw canvasR.reason;
  const canvas = canvasR.value;
  let tile: HTMLCanvasElement | null = null;
  try {
    if (detR.status === 'rejected') throw detR.reason;
    const det = detR.value;
    const W = canvas.width;
    const H = canvas.height;
    const found: { x: number; y: number; w: number; h: number; score: number }[] = [];

    const run = (src: HTMLCanvasElement, ox: number, oy: number): void => {
      for (const d of det.detect(src).detections) {
        const b = d.boundingBox;
        if (!b) continue;
        found.push({
          x: (ox + b.originX) / W,
          y: (oy + b.originY) / H,
          w: b.width / W,
          h: b.height / H,
          score: d.categories[0]?.score ?? 0,
        });
      }
    };

    const tiles = faceTiles(W, H);
    const total = tiles.length + 1;
    onProgress?.(0, total);
    run(canvas, 0, 0);
    onProgress?.(1, total);
    if (tiles.length) {
      // 区画の canvas は 1 枚を使い回す（大きさが変わるときだけ作り直す）
      tile = document.createElement('canvas');
      const tcx = tile.getContext('2d')!;
      for (const [i, t] of tiles.entries()) {
        if (i % YIELD_EVERY === 0) await yieldToMain();
        if (tile.width !== t.w || tile.height !== t.h) {
          tile.width = t.w;
          tile.height = t.h;
        }
        tcx.clearRect(0, 0, t.w, t.h);
        tcx.drawImage(canvas, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
        run(tile, t.x, t.y);
        onProgress?.(i + 2, total);
      }
    }
    return mergeDetections(found);
  } finally {
    if (tile) releaseCanvas(tile);
    releaseCanvas(canvas);
  }
}

/**
 * 隠す枠にモザイクをかけた JPEG を作る（検出と同じ、上限の内側に縮めた大きさ）。canvas から作り直すので EXIF は載らない。
 * 隠す枠が無ければ null。
 */
export async function makeMaskedJpeg(key: string, faces: PhotoFace[]): Promise<Blob | null> {
  const hidden = hiddenFaces(faces);
  if (!hidden.length) return null;
  const canvas = await loadPhotoCanvas(key);
  try {
    const cx = canvas.getContext('2d')!;
    for (const f of hidden) {
      const r = mosaicRect(f, canvas.width, canvas.height);
      if (!r.w || !r.h) continue;
      const img = cx.getImageData(r.x, r.y, r.w, r.h);
      pixelate(img.data, r.w, { x: 0, y: 0, w: r.w, h: r.h, block: r.block });
      cx.putImageData(img, r.x, r.y);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('モザイクをかけた写真を作れませんでした');
    return blob;
  } finally {
    releaseCanvas(canvas);
  }
}
