import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { nameTry } from '../../../lib/native/text-tools';
import type { NameEntry } from '../../../lib/names/replace';
import { list, str } from './_input';

export const prerender = false;

/**
 * POST /api/native/name-try {text, entries[]} → {text, spans}（iPhone 版・かけら帳ネイティブ化設計）
 * 名前の辞書の試し書き。Web 版の NameMapScreen と同じく、記号にしてから辞書どおりに解く。D1 は読まない（辞書は画面が持っているもの）。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    ctxOf(locals);
    const input = await readJson(request);
    const entries = list<NameEntry>(input.entries, 'entries').map((e) => {
      if (!e || typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') {
        throw new ApiError(400, 'entries は {id, source, target} で送ってください');
      }
      return { id: e.id, source: e.source, target: e.target };
    });
    return json(nameTry(str(input.text, 'text'), entries));
  });
