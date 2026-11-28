// /api/native/* の入力を形だけ検める（iPhone 版から届くもの・かけら帳ネイティブ化設計）。
// ⚠️ 中身の突き合わせはしない（どの口も D1 を読まない純関数）。崩れた形は 400 にする。

import { ApiError } from '../../../lib/http';
import type { LinkCards } from '../../../lib/card/types';

export function strings(v: unknown, name: string, max = 2000): string[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string')) {
    throw new ApiError(400, `${name} は文字列の並びで送ってください`);
  }
  return v as string[];
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new ApiError(400, `${name} は文字列で送ってください`);
  return v;
}

export function list<T>(v: unknown, name: string, max = 5000): T[] {
  if (!Array.isArray(v) || v.length > max) throw new ApiError(400, `${name} は並びで送ってください`);
  return v as T[];
}

export function cardsOf(v: unknown): LinkCards {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'cards は辞書で送ってください');
  return v as LinkCards;
}
