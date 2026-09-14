import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { recordNikki } from '../../../../lib/kakera/db';
import { publishNikki } from '../../../../lib/publish/astro-blog';
import { prepareNikkiExport } from '../../../../lib/publish/nikki-export';
import { syncKatachi } from '../../../../lib/backup/sync';

export const prerender = false;

/**
 * POST /api/katachi/:id/nikki — 日記にする／組み直す
 * {kakera_ids[]（この順）, title?, choices?: [{ref_id, action, text?}], photos?[], confirm_real_names?, doc_revs: [{doc_id, rev}], dict_rev}
 *
 * ★毎回ファイルを丸ごと上書きする（差分追記ではない）。
 * ★nikki に行が無いのに astro-blog に同じ日付のファイルがあれば 409（publishNikki 側の安全弁）。
 * ★公開名変換（記号方式）: 本文・タイトル・説明は**サーバが D1 の文書から解き直す**。画面から本文を受け取らない。
 *   開いた後に文書・辞書が変わっていれば 409（画面に見えていない文を出さない）。
 *   記号が解けない・記号になっていない実名・出さない写真の取り残しがあれば 409（astro-blog にも公開バケットにも書かない）。
 *   組み立ては lib/publish/nikki-export.ts。
 * ★実名のまま出る箇所（拒否）が残るときは、confirm_real_names: true が無ければ 409（念押しを経ていない）。
 * ★写真の出す／出さない（photos?[] = 出さない写真 {kakera_id, key}）: 原本か日記用の文に実在する key だけ当てる。
 *   photos を送らない呼び出しは、D1 に覚えてある選択を使う。出さない写真は公開バケットへもコピーしない。
 * ★原本（kakera の行・控え）は触らない。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);

    const prepared = await prepareNikkiExport(env.DB, id, input);
    const { path } = await publishNikki(env, prepared.publish);

    await recordNikki(env.DB, id, prepared.detail.katachi.date, prepared.chosen.map((k) => k.id));
    // 控えのかたちにも「日記 #n」の印を反映する（控えは原本なので実名のまま）
    waitUntil(syncKatachi(env, id));

    return json({ ok: true, path, slug: prepared.detail.katachi.date });
  });
