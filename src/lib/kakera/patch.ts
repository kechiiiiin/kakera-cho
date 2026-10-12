// PATCH /api/kakera/:id の入力の検査（かけら時刻の指定と修正設計・2026-10-12）。
// body だけ・written_at だけ・両方のどれでもよい。どちらも無ければ 400。

import { ApiError } from '../http';
import { writtenAtFromInput } from '../time';

export interface KakeraPatch {
  body?: string;
  /** 検査済み・+09:00・秒は 00 */
  written_at?: string;
}

export function parseKakeraPatch(input: Record<string, unknown>, nowMs: number = Date.now()): KakeraPatch {
  const patch: KakeraPatch = {};
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || !input.body.trim()) throw new ApiError(400, '本文が空です');
    patch.body = input.body.trim();
  }
  if (input.written_at !== undefined) {
    // POST と同じ isWrittenAt・normalizeToJst を通す。未来（数分のずれを超える）は拒否
    const r = writtenAtFromInput(input.written_at, nowMs);
    if (!r.ok) throw new ApiError(400, r.error);
    patch.written_at = r.value;
  }
  if (patch.body === undefined && patch.written_at === undefined) {
    throw new ApiError(400, '本文か書いた日時（written_at）を送ってください');
  }
  return patch;
}
