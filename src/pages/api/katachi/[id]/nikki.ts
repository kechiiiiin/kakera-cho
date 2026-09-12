import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail, recordNikki } from '../../../../lib/kakera/db';
import { publishNikki } from '../../../../lib/publish/astro-blog';
import { syncKatachi } from '../../../../lib/backup/sync';

export const prerender = false;

/**
 * POST /api/katachi/:id/nikki — 日記にする／組み直す
 * {kakera_ids[]（この順）, title?}
 *
 * ★毎回ファイルを丸ごと上書きする（差分追記ではない）。
 * ★nikki に行が無いのに astro-blog に同じ日付のファイルがあれば 409（publishNikki 側の安全弁）。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);

    const ids = input.kakera_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) {
      throw new ApiError(400, '日記に出すかけらが選ばれていません');
    }

    const detail = await getKatachiDetail(env.DB, id);
    const byId = new Map(detail.kakera.map((k) => [k.id, k]));
    const chosen = (ids as string[]).map((kid) => {
      const k = byId.get(kid);
      if (!k) throw new ApiError(400, `このかたちに無いかけらが選ばれています: ${kid}`);
      return k;
    });

    // 書き出す画面でタイトルを変えられる。初期値は katachi.title。
    // 組み直し方式なので、変えた題も次の書き出しで初期値に戻る（D1 には保存しない）。
    const title =
      typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : detail.katachi.title;

    const { path } = await publishNikki(env, {
      date: detail.katachi.date,
      title,
      kakera: chosen,
      alreadyPublished: !!detail.nikki,
    });

    await recordNikki(env.DB, id, detail.katachi.date, chosen.map((k) => k.id));
    // 控えのかたちにも「日記 #n」の印を反映する
    waitUntil(syncKatachi(env, id));

    return json({ ok: true, path, slug: detail.katachi.date });
  });
