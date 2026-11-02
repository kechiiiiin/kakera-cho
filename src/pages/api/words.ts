import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { getWordDetail, listWords } from '../../lib/kakera/db';

export const prerender = false;

/**
 * GET /api/words — ことばの索引 {words: [{word, count, last_written_at}]}（新しく書いた順）
 * GET /api/words?word=… — 言葉のページ {word, kakera: [かけら＋katachi_date], cards}（新しい順）
 * 表は持たず、問い合わせのたびに本文から抜き出す（かけら言葉リンク設計 §2.1）。
 */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const word = url.searchParams.get('word');
    if (word === null) return json({ words: await listWords(env.DB) });
    if (!word.trim()) throw new ApiError(400, '言葉が空です');
    return json(await getWordDetail(env.DB, word));
  });
