import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail } from '../../../../lib/kakera/db';
import {
  listNameMap,
  loadChoices,
  parseSegChoices,
  pickKakera,
  resolveNikkiTitle,
  saveChoices,
  validateChoices,
} from '../../../../lib/names/db';

export const prerender = false;

/**
 * POST /api/katachi/:id/name-choice — 変換ページを開くときに読む
 * {kakera_ids[]（この順）, title?} → {entries（辞書）, title（日記に使うタイトル）, choices, reset_kakera_ids, reset_title}
 *
 * ⚠️ タイトル（実名を含みうる）を URL のクエリに載せないため、読むのも POST にしている。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    const kakera = pickKakera(detail, input.kakera_ids);
    const title = resolveNikkiTitle(input.title, detail.katachi.title);
    const entries = await listNameMap(env.DB);
    const loaded = await loadChoices(env.DB, entries, params.id, title, kakera);
    return json({ entries, title, ...loaded });
  });

/**
 * PUT /api/katachi/:id/name-choice — 選択を覚える
 * {kakera_ids[], title?, choices[]} このかたちのタイトルと、渡したかけらの選択を丸ごと入れ替える。
 * 届いた選択は原本から計算し直した当たり箇所と突き合わせ、位置と置き換え元が一致するものだけ残す。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    const kakera = pickKakera(detail, input.kakera_ids);
    const title = resolveNikkiTitle(input.title, detail.katachi.title);
    const entries = await listNameMap(env.DB);
    const valid = validateChoices(entries, title, kakera, parseSegChoices(input.choices));
    await saveChoices(env.DB, params.id, title, kakera, valid);
    return json({ ok: true, choices: valid });
  });
