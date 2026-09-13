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
import { loadPublishSet } from '../../../../lib/publish/publish-body-db';

export const prerender = false;

/**
 * POST /api/katachi/:id/name-choice — 変換ページを開くときに読む
 * {kakera_ids[]（この順）, title?} → {entries（辞書）, title（日記に使うタイトル）, description（D1 に保存した説明）,
 *   choices, reset_kakera_ids, reset_title, reset_description}
 * ★説明は画面から受け取らない。D1 の katachi.description が原本（「日記にする」画面が PATCH で先に保存する）。
 *
 * ⚠️ タイトル（実名を含みうる）を URL のクエリに載せないため、読むのも POST にしている。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    // 日記用に直した本文があるかけらは、その本文で当たり箇所を計算し、選択の basis もその本文に紐づける
    const { kakera } = await loadPublishSet(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    const title = resolveNikkiTitle(input.title, detail.katachi.title);
    const entries = await listNameMap(env.DB);
    const description = detail.katachi.description ?? '';
    const loaded = await loadChoices(env.DB, entries, params.id, title, kakera, description);
    return json({ entries, title, description, ...loaded });
  });

/**
 * PUT /api/katachi/:id/name-choice — 選択を覚える
 * {kakera_ids[], title?, choices[]} このかたちのタイトル・説明と、渡したかけらの選択を丸ごと入れ替える。
 * 説明の選択の basis は D1 の説明（画面の文字は使わない）。
 * 届いた選択は原本から計算し直した当たり箇所と突き合わせ、位置と置き換え元が一致するものだけ残す。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    // 日記用に直した本文があるかけらは、その本文で当たり箇所を計算し、選択の basis もその本文に紐づける
    const { kakera } = await loadPublishSet(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    const title = resolveNikkiTitle(input.title, detail.katachi.title);
    const entries = await listNameMap(env.DB);
    const description = detail.katachi.description ?? '';
    const valid = validateChoices(entries, title, kakera, parseSegChoices(input.choices), description);
    await saveChoices(env.DB, params.id, title, kakera, valid, description);
    return json({ ok: true, choices: valid });
  });
