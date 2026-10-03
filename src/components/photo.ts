// 写真を貼る。blog-cms のスマホ対応で得た知見をそのまま使う（依存ライブラリはゼロ）。
//
//   - 長辺 2048px / JPEG 0.85 に落としてから送る（iPhone の写真は 3〜10MB ある）
//   - フォールバックの三段構え: デコード不能／toBlob が null／縮んでいない → いずれも原本を送る
//   - GIF・SVG は素通し（アニメと図を壊さない）
//   - HEIC は変換ライブラリを入れない。写真アプリから選べば iOS が JPEG にしてくれる。
//     生で来たときはサーバが親切なエラーを返す
//   - 複数選択は直列ループ（順序を保ち、回線を平らに使う）

import { api } from './api';

const MAX_EDGE = 2048;
const QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file; // デコードできない（HEIC 等）ならそのまま送ってサーバに判断させる
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext('2d');
  if (!cx) return file;
  cx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) return file;
  if (blob.size >= file.size) return file; // 縮まないなら原本のまま

  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
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
