// 写真を貼る。blog-cms のスマホ対応で得た知見をそのまま使う（依存ライブラリはゼロ）。
//
//   - 画素数（面積）の上限まで縮め、JPEG 0.85 にしてから送る（iPhone の写真は 3〜10MB ある）。
//     普通の写真（縦横比 2 以下）は面積 ≤ 2048×2048（約 4.2MP）、細長い画像（縦横比 2 超）は横幅を保つ方を優先して
//     面積 ≤ 12MP・長辺 ≤ 16384px（fitUploadSize）。元が上限内なら縮めない（拡大もしない）
//     （2026-10-12 縦長画像で変更。長辺 2048px で縮めていたため、縦横比 1:15 のスクリーンショットが 95×2048 になり読めなかった）
//   - 描く canvas は上限の内側（≤ 12MP）なので、iOS Safari の canvas の上限（約 16.7MP）を越えない。
//     原本がそれより大きくても、原寸の canvas は作らない（ImageBitmap から縮めて描くだけ）
//   - 白で下地を塗ってから描く（透明の PNG が JPEG で黒く抜けない）。それでも描けていない（全部透明の）canvas なら原本を送る
//   - フォールバックの三段構え: デコード不能／toBlob が null／縮んでいない → いずれも原本を送る（＋描けていない canvas）。
//     原本が 20MB を越えるときはサーバが 413 で断る（src/pages/api/photo/index.ts）。黙って巨大なまま保存されることはない
//   - GIF・SVG は素通し（アニメと図を壊さない）
//   - HEIC は変換ライブラリを入れない。写真アプリから選べば iOS が JPEG にしてくれる。
//     生で来たときはサーバが親切なエラーを返す
//   - 複数選択は直列ループ（順序を保ち、回線を平らに使う）

import { api } from './api';
import { fitUploadSize } from '../lib/image/fit-size';
import { blankProbePoints, looksBlank } from '../lib/publish/photo-face';

const QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file; // デコードできない（HEIC 等）ならそのまま送ってサーバに判断させる
  }

  const { width: w, height: h } = fitUploadSize(bitmap.width, bitmap.height);
  if (!w || !h) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement('canvas');
  try {
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) return file;
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, w, h);
    cx.drawImage(bitmap, 0, 0, w, h);
    // 描けていない canvas（iOS が黙って空にした等）を JPEG にすると真っ黒な写真になる。原本を送る
    const samples = blankProbePoints(w, h).map((p) => cx.getImageData(p.x, p.y, p.w, p.h).data);
    if (looksBlank(samples)) return file;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) return file;
    if (blob.size >= file.size) return file; // 縮まないなら原本のまま

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } finally {
    bitmap.close();
    // iOS Safari は canvas の合計の大きさにも上限がある。使い終わったらすぐ縮めて返す
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 隠しの input を出して写真を選ばせる（撮影も選べる）。 */
export function pickPhotos(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      input.value = ''; // 同じ写真の選び直しを許す
      input.remove();
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

/** 1枚を縮めて上げ、URL を返す。n は本文の中で何枚目か（key の連番）。失敗は投げる。 */
export async function uploadOnePhoto(file: File, target: { kakeraId: string; writtenAt: string; n: number }): Promise<string> {
  const compressed = await compressImage(file);
  const form = new FormData();
  form.append('file', compressed);
  form.append('kakera_id', target.kakeraId);
  form.append('written_at', target.writtenAt);
  form.append('n', String(target.n));
  const { url } = await api.uploadPhoto(form);
  return url;
}
