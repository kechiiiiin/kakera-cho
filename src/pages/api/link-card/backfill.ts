import type { APIRoute } from 'astro';
import { handle, json } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { listBodiesWithUrls } from '../../../lib/kakera/db';
import { MAX_PER_RUN, fetchCardsInOrder, pendingCardUrls } from '../../../lib/card/ensure';

export const prerender = false;

/**
 * POST /api/link-card/backfill — 既にあるかけらの、まだカードの無い URL を裏で取りに行く。
 *
 * 画面にボタンは無い。認証の裏で、ブラウザのコンソールから叩く:
 *   await (await fetch('/api/link-card/backfill', { method: 'POST' })).json()
 *
 * ⚠️ 1回で取りに行くのは MAX_PER_RUN 本まで（Workers の waitUntil の時間とサブリクエスト数の上限のため）。
 * 戻りの `remaining` が 0 になるまで、少し間を空けて叩き直す。取れたもの・失敗を記録したものは
 * 次の回で拾わないので、何度叩いても同じ相手を二度叩かない（失敗は 7 日は放っておく）。
 */
export const POST: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const bodies = await listBodiesWithUrls(env.DB);
    const pending = await pendingCardUrls(env.DB, bodies);
    const batch = pending.slice(0, MAX_PER_RUN);
    if (batch.length) waitUntil(fetchCardsInOrder(env, batch));
    return json({
      pending: pending.length,
      started: batch,
      remaining: pending.length - batch.length,
    });
  });
