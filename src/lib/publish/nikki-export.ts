// 書き出しの組み立て（POST /api/katachi/:id/nikki の、astro-blog に書く手前まで）。
// 公開名変換設計・記号方式の同期と書き出し §2 の順:
//  1. 出すかけら（並び順）・辞書を読み、関わる文書を今に合わせる（書き込まずに見る）
//  2. 開いた後に文書・辞書が変わっていれば 409「内容が変わりました。開き直してください」（doc_revs・dict_rev）
//  3. 届いた選択を D1 に保存（書き出しに失敗しても選んだことは残る）
//  4〜8. 記号を解く → 出さない写真を除く → 取り残しの検査（names/assemble.ts。止まれば 409）
//  9. 空なら 400。拒否が残り confirm_real_names が無ければ 409
// ★画面から本文を受け取らない。届くのは並び・タイトルの入力・選択・写真・doc_revs・dict_rev・念押しだけ。
// ★原本（kakera の行）には触らない。

import type { Kakera, KatachiDetail } from '../kakera/types';
import { ApiError } from '../http';
import { getKatachiDetail } from '../kakera/db';
import { composeBody } from '../markdown';
import { listNameMap, pickKakera, resolveNikkiTitle } from '../names/db';
import { assembleNikki } from '../names/assemble';
import { NameDocError } from '../names/doc';
import {
  CHANGED_MESSAGE,
  applyExportChoices,
  dictRev,
  publishRealTexts,
  syncDiaryDocs,
  usedDocs,
} from '../names/doc-db';
import { hiddenKeysOf, parsePhotoChoices, validatePhotoChoices, type PhotoChoice } from './photo-choice';
import { loadPhotoChoices, savePhotoChoices } from './photo-choice-db';
import { photoBasisOf } from './publish-body';
import type { PublishInput } from './astro-blog';

export interface PreparedNikki {
  detail: KatachiDetail;
  chosen: Kakera[];
  publish: PublishInput;
  photos: PhotoChoice[];
}

function parseDocRevs(raw: unknown): Map<string, string> {
  if (!Array.isArray(raw)) throw new ApiError(400, 'doc_revs がありません。開き直してください。');
  const out = new Map<string, string>();
  for (const x of raw) {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.doc_id !== 'string' || typeof o.rev !== 'string') throw new ApiError(400, 'doc_revs の形が違います');
    out.set(o.doc_id, o.rev);
  }
  return out;
}

export async function prepareNikkiExport(db: D1Database, katachiId: string, input: Record<string, unknown>): Promise<PreparedNikki> {
  const detail = await getKatachiDetail(db, katachiId);
  const chosen = pickKakera(detail, input.kakera_ids);
  // タイトルは「日記にする」画面で変えられる。初期値は katachi.title（かたちの題は変えない）
  const title = resolveNikkiTitle(input.title, detail.katachi.title);
  // 説明は画面から受け取らず、D1 に保存した katachi.description を使う
  const description = detail.katachi.description ?? '';
  const dict = await listNameMap(db);

  // 1・2
  const docs = await syncDiaryDocs(db, katachiId, chosen, title, description, dict, { write: false });
  const used = usedDocs(docs, chosen, description);
  const sentRevs = parseDocRevs(input.doc_revs);
  if (typeof input.dict_rev !== 'string') throw new ApiError(400, 'dict_rev がありません。開き直してください。');
  if (used.some((u) => u.state.changed || !u.state.row)) throw new ApiError(409, CHANGED_MESSAGE);
  if (sentRevs.size !== used.length || used.some((u) => sentRevs.get(u.state.row!.id) !== u.state.row!.rev)) {
    throw new ApiError(409, CHANGED_MESSAGE);
  }
  if (input.dict_rev !== (await dictRev(dict))) throw new ApiError(409, CHANGED_MESSAGE);
  // 形が崩れた文書はどの段かを出して止める（届いた選択はその文書の記号と照らせないので、先に見る）
  const broken = used.find((u) => u.state.broken);
  if (broken) throw new ApiError(409, `${broken.label}の名前の記号が読めません（形が崩れています）。開き直してください。`);

  // 3
  await applyExportChoices(db, used, dict, input.choices);

  // 写真の選択は原本か日記用の文のどちらかに実在する key まで残す
  const photoBasis = photoBasisOf(
    chosen,
    await publishRealTexts(
      db,
      katachiId,
      chosen.map((k) => k.id)
    )
  );
  const sentPhotos = parsePhotoChoices(input.photos);
  const photos = sentPhotos ? validatePhotoChoices(photoBasis, sentPhotos) : await loadPhotoChoices(db, photoBasis);

  // 4〜8
  const part = (u: (typeof used)[number]) => ({
    seg: u.seg,
    label: u.label,
    shape: u.state.broken ? null : u.state.shape,
    ...(u.expected !== undefined ? { expected: u.expected } : {}),
  });
  let assembled;
  try {
    assembled = assembleNikki(
      {
        title: { ...part(used[0]!), expected: title, body: false },
        description: description ? { ...part(used[1]!), body: false } : null,
        bodies: used
          .slice(description ? 2 : 1)
          .map((u) => ({ ...part(u), body: true, hidden: hiddenKeysOf(photos, u.seg) })),
      },
      dict
    );
  } catch (e) {
    if (e instanceof NameDocError) throw new ApiError(409, e.message);
    throw e;
  }

  // 9. 写真をすべて出さないにしたかけらが重なる等で、書き出す本文がまるごと空になるときは止める
  const bodies = assembled.bodies.map((b) => b.text);
  if (!composeBody(bodies).trim()) {
    throw new ApiError(400, '日記に出す内容がありません。写真をすべて出さないにしたかけらは日記から外れます。');
  }
  if (assembled.rejects.length && input.confirm_real_names !== true) {
    throw new ApiError(409, `実名のまま出る箇所が ${assembled.rejects.length} つあります。変換の画面で確かめてから書き出してください。`);
  }
  if (sentPhotos) await savePhotoChoices(db, photoBasis, photos);

  return {
    detail,
    chosen,
    photos,
    publish: {
      date: detail.katachi.date,
      title: assembled.title.text,
      description: assembled.description?.text ?? '',
      bodies,
      hiddenPhotoKeys: new Set(photos.map((p) => p.key)),
      alreadyPublished: !!detail.nikki,
    },
  };
}
