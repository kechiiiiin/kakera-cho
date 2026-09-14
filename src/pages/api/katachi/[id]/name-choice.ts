import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail } from '../../../../lib/kakera/db';
import { listNameMap, pickKakera, resolveNikkiTitle } from '../../../../lib/names/db';
import { chooseRef, diaryDocViews, dictRev, syncDiaryDocs } from '../../../../lib/names/doc-db';

export const prerender = false;

/**
 * POST /api/katachi/:id/name-choice — 変換ページを開くときに読む
 * {kakera_ids[]（この順）, title?} → {entries（辞書）, title（日記に使うタイトル）, description（D1 に保存した説明）, dict_rev,
 *   docs: [{seg, kind, doc_id, rev, segments, refs: [{id, source, action, text}], lost_choices, basis, stale, updated_at}]}
 * ★ここで文書の同期が走る（原本・タイトル・説明が直されていれば差分で名前を追い、辞書が変わっていれば整える）。
 *   かけらごとに原本の文書（kind = kakera）と、書き換えがあれば日記用の文書（kind = publish）の両方を返す。
 * ★説明は画面から受け取らない。D1 の katachi.description が原本。
 *
 * ⚠️ タイトル（実名を含みうる）を URL のクエリに載せないため、読むのも POST にしている。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    const chosen = pickKakera(detail, input.kakera_ids);
    const title = resolveNikkiTitle(input.title, detail.katachi.title);
    const entries = await listNameMap(env.DB);
    const description = detail.katachi.description ?? '';
    const docs = await syncDiaryDocs(env.DB, params.id, chosen, title, description, entries, { write: true, repair: true });
    return json({
      entries,
      title,
      description,
      dict_rev: await dictRev(entries),
      docs: diaryDocViews(docs, chosen),
    });
  });

/**
 * PUT /api/katachi/:id/name-choice — 記号一つの選択を覚える
 * {ref_id, action: 'approve' | 'edit' | 'reject', text?} → {ref}
 * この日記の文書に無い記号は 409（開き直してください）、例外の名前・中身の無い言葉は 400。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const entries = await listNameMap(env.DB);
    const ref = await chooseRef(env.DB, params.id, entries, input);
    return json({ ref });
  });
