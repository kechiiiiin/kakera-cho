import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { wordPlan } from '../../../lib/native/text-tools';
import { cardsOf, list, strings } from './_input';

export const prerender = false;

/**
 * POST /api/native/word-plan {kakera: [{id, body}]（書いた順）, pages[]（言葉の索引）, cards?}
 *   → {rows: [{key, kakera_id, word, start, end, before, after}]}（iPhone 版・かけら帳ネイティブ化設計）
 * 「かたちにする」の前の、既にページがある言葉の確認。Web 版の planWordLinks と candidateContext と同じ。D1 は読まない。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    ctxOf(locals);
    const input = await readJson(request);
    const kakera = list<{ id: unknown; body: unknown }>(input.kakera, 'kakera', 2000).map((k) => {
      if (!k || typeof k.id !== 'string' || typeof k.body !== 'string') throw new ApiError(400, 'kakera は {id, body} で送ってください');
      return { id: k.id, body: k.body };
    });
    return json({ rows: wordPlan(kakera, strings(input.pages, 'pages', 20000), cardsOf(input.cards)) });
  });
