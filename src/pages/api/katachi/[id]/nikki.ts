import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail, recordNikki } from '../../../../lib/kakera/db';
import { publishNikki } from '../../../../lib/publish/astro-blog';
import { composeBody } from '../../../../lib/markdown';
import { syncKatachi } from '../../../../lib/backup/sync';
import {
  DESCRIPTION_SEG,
  listNameMap,
  parseSegChoices,
  pickKakera,
  resolveNikkiTitle,
  saveChoices,
  validateChoices,
} from '../../../../lib/names/db';
import { choiceMap, convertText } from '../../../../lib/names/replace';
import {
  convertForPublish,
  hiddenKeysOf,
  parsePhotoChoices,
  validatePhotoChoices,
} from '../../../../lib/publish/photo-choice';
import { loadPhotoChoices, savePhotoChoices } from '../../../../lib/publish/photo-choice-db';
import { loadPublishSet } from '../../../../lib/publish/publish-body-db';

export const prerender = false;

/**
 * POST /api/katachi/:id/nikki — 日記にする／組み直す
 * {kakera_ids[]（この順）, title?, choices?[], confirm_real_names?}
 *
 * ★毎回ファイルを丸ごと上書きする（差分追記ではない）。
 * ★nikki に行が無いのに astro-blog に同じ日付のファイルがあれば 409（publishNikki 側の安全弁）。
 * ★公開名変換: 本文とタイトルと説明は**サーバ側で原本から置き換え直す**。画面から届いた本文は受け取らない。
 *   説明は画面から受け取らず、D1 に保存した katachi.description を使う（「日記にする」画面が先に PATCH で保存する）。
 *   届いた選択は、原本から計算し直した当たり箇所と「位置と置き換え元」が一致するものだけ当て、
 *   一致しないものは辞書どおりに倒す。
 * ★実名のまま出る箇所（拒否）が残るときは、confirm_real_names: true が無ければ 409（念押しを経ていない）。
 * ★写真の出す／出さない（photos?[] = 出さない写真 {kakera_id, key}）: これも**原本から拾い直して**当てる。
 *   届いた選択は「そのかけらの原本に実在する写真の key」に一致するものだけ効く。
 *   photos を送らない呼び出し（配列でない）は、D1 に覚えてある選択を使う（出さないはずの写真を黙って出さないため）。
 *   出さない写真は公開版の本文から画像記法ごと除き、公開バケットへもコピーしない。
 *   順番: 名前の当たり箇所・選択の照合は原本の位置で行い、写真を除くのは同じ一回の走査の中
 *   （convertForPublish）。先に写真を除くと位置がずれて名前の選択が落ちるため。
 * ★日記用に直した本文（publish_body）: かけらごとに「書き換えがあればそれ、無ければ原本」を D1 から取る。
 *   組み立て順は 書き換えを当てる → 名前の置き換え＋出さない写真を除く（convertForPublish・その本文の位置で）
 *   → 写真の URL の差し替え → 空行の保持（composePublishBody）→ カードの JSON（blogCardKeysOf）→ 日記の .md。
 *   書き換えは画面から受け取らない（保存は /publish-body/:kid）。原本（kakera の行・控え）は触らない。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);

    const detail = await getKatachiDetail(env.DB, id);
    // 日記用に直した本文（publish_body）があるかけらは、それを本文として扱う。D1 から読む（画面からは受け取らない）。
    // 以後の名前の当たり箇所・選択の照合・写真の除去・空行の保持・カードの URL は、すべてこの本文に当たる。
    const set = await loadPublishSet(env.DB, id, pickKakera(detail, input.kakera_ids));
    const chosen = set.kakera;

    // タイトルは「日記にする」画面で変えられる。初期値は katachi.title。
    // 組み直し方式なので、変えた題も次の書き出しで初期値に戻る（かたちの題は変えない）。
    const title = resolveNikkiTitle(input.title, detail.katachi.title);

    const entries = await listNameMap(env.DB);
    const description = detail.katachi.description ?? '';
    const valid = validateChoices(entries, title, chosen, parseSegChoices(input.choices), description);
    const bySeg = (seg: string) => choiceMap(valid.filter((c) => c.seg === seg));

    const sentPhotos = parsePhotoChoices(input.photos);
    // 写真の選択は原本か書き換えのどちらかに実在する key まで残す（publish-body.ts の photoBasisOf）
    const photos = sentPhotos
      ? validatePhotoChoices(set.photoBasis, sentPhotos)
      : await loadPhotoChoices(env.DB, set.photoBasis);

    const titleOut = convertText(title, entries, bySeg('title'));
    const descriptionOut = convertText(description, entries, bySeg(DESCRIPTION_SEG));
    const bodiesOut = chosen.map((k) => convertForPublish(k.body, entries, bySeg(k.id), hiddenKeysOf(photos, k.id)));

    // 写真をすべて出さないにしたかけらが重なる等で、書き出す本文がまるごと空になるときは止める（composeBody は
    // 空のかけらを飛ばして連結するので、これは「1枚も中身が残らなかった」ときだけ真になる）。
    if (!composeBody(bodiesOut.map((r) => r.text)).trim()) {
      throw new ApiError(
        400,
        '日記に出す内容がありません。写真をすべて出さないにしたかけらは日記から外れます。'
      );
    }

    const rejects = [titleOut, descriptionOut, ...bodiesOut].reduce(
      (n, r) => n + r.applied.filter((c) => c.action === 'reject').length,
      0
    );
    if (rejects > 0 && input.confirm_real_names !== true) {
      throw new ApiError(409, `実名のまま出る箇所が ${rejects} つあります。変換の画面で確かめてから書き出してください。`);
    }

    // 選択を覚える（書き出しに失敗しても、選んだことは残す）
    await saveChoices(env.DB, id, title, chosen, valid, description);
    if (sentPhotos) await savePhotoChoices(env.DB, chosen, photos);

    const { path } = await publishNikki(env, {
      date: detail.katachi.date,
      title: titleOut.text,
      description: descriptionOut.text,
      bodies: bodiesOut.map((r) => r.text),
      hiddenPhotoKeys: new Set(photos.map((p) => p.key)),
      alreadyPublished: !!detail.nikki,
    });

    await recordNikki(env.DB, id, detail.katachi.date, chosen.map((k) => k.id));
    // 控えのかたちにも「日記 #n」の印を反映する（控えは原本なので実名のまま）
    waitUntil(syncKatachi(env, id));

    return json({ ok: true, path, slug: detail.katachi.date });
  });
