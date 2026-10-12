// 写真の顔の検出とモザイク（顔モザイク設計 §3.1・§3.3）。変換ページだけが使う。
//
//   - 検出はブラウザの中で行う（写真を外部へ送らない）。MediaPipe Tasks Vision の Face Detector（full range）
//   - 検出モデルは**呼ばれたときに初めて読み込む**（import() で別の塊にする）。他の画面の重さは変わらない
//   - 版は固定（package.json の @mediapipe/tasks-vision と wasm・モデルの URL を揃える。photo-face.ts の FACE_MODEL）
//   - しきい値は 0.4。拾いすぎる側に倒す。full range でも入力は 192px に縮むので、
//     大きい写真は 2×2 の区画（重ねしろ付き）でも検出して、小さい顔を拾い漏らしにくくする
//   - モザイクは原寸にかける。canvas から作り直した JPEG には EXIF が載らない

import type { FaceDetector } from '@mediapipe/tasks-vision';
import { hiddenFaces, mergeDetections, mosaicRect, pixelate, type PhotoFace } from '../lib/publish/photo-face';
import { photoUrlFor } from '../lib/publish/photos';

const MP_VERSION = '0.10.35';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite';
const THRESHOLD = 0.4;
/** これより長辺が大きい写真は区画でも検出する */
const TILE_FROM = 800;

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
 * 原本を読んで、向きを直した原寸の canvas にする。
 * ⚠️ <img> 経由で描く（今の Safari・Chrome は EXIF の向きを当てて描く）。画面に見えている向きと枠の位置を揃える。
 */
export async function loadPhotoCanvas(key: string): Promise<HTMLCanvasElement> {
  const res = await fetch(photoUrlFor(key));
  if (!res.ok) throw new Error(`写真を読めませんでした（${res.status}）`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cx = canvas.getContext('2d');
    if (!cx) throw new Error('canvas が使えません');
    cx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 写真の顔を探す。見つけた枠は全部「隠す」で返す（0 件もありうる）。 */
export async function detectFaces(key: string): Promise<PhotoFace[]> {
  const [det, canvas] = await Promise.all([loadDetector(), loadPhotoCanvas(key)]);
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

  run(canvas, 0, 0);
  if (Math.max(W, H) > TILE_FROM) {
    // 2×2 の区画（縦横 6 割ずつ＝重ねしろ 2 割）
    const tw = Math.round(W * 0.6);
    const th = Math.round(H * 0.6);
    for (const ox of [0, W - tw]) {
      for (const oy of [0, H - th]) {
        const tile = document.createElement('canvas');
        tile.width = tw;
        tile.height = th;
        tile.getContext('2d')!.drawImage(canvas, ox, oy, tw, th, 0, 0, tw, th);
        run(tile, ox, oy);
      }
    }
  }
  return mergeDetections(found);
}

/**
 * 隠す枠にモザイクをかけた JPEG を作る（原寸）。canvas から作り直すので EXIF は載らない。
 * 隠す枠が無ければ null。
 */
export async function makeMaskedJpeg(key: string, faces: PhotoFace[]): Promise<Blob | null> {
  const hidden = hiddenFaces(faces);
  if (!hidden.length) return null;
  const canvas = await loadPhotoCanvas(key);
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
}
