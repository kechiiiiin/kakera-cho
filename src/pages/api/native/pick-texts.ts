import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { pickTexts } from '../../../lib/native/text-tools';
import { cardsOf, strings } from './_input';

export const prerender = false;

/**
 * POST /api/native/pick-texts {bodies[], cards?} → {texts[]}（iPhone 版・かけら帳ネイティブ化設計）
 * 選ぶ所（かたちにする・かけらを足す・日記にする）の抜粋。Web 版の textForPick と同じ。
 * 本文（実名を含みうる）を URL に載せないので POST。D1 は読まない。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    ctxOf(locals);
    const input = await readJson(request);
    return json({ texts: pickTexts(strings(input.bodies, 'bodies'), cardsOf(input.cards)) });
  });
