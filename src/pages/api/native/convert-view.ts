import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { convertView, type ConvertKakera } from '../../../lib/native/convert-view';
import type { NameEntry } from '../../../lib/names/replace';
import type { DocView } from '../../../lib/names/doc-db';
import { parsePhotoChoices } from '../../../lib/publish/photo-choice';
import { cardsOf, list, str, strings } from './_input';

export const prerender = false;

/**
 * POST /api/native/convert-view（iPhone 版の変換ページ・かけら帳ネイティブ化設計）
 * {katachi_date, kakera: [{id, body, written_at, show_time?}], order[], title, description, entries[], docs[], photos[], cards?}
 *   → 画面に出すもの（lib/native/convert-view.ts の ConvertView）
 * Web 版の ConvertScreen.tsx が画面の中で組んでいるものを、同じ関数で組んで返すだけ。D1 は読まない・書かない。
 * 文書・辞書は name-choice が返したものを画面がそのまま送る（実名を含むので POST）。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    ctxOf(locals);
    const input = await readJson(request);
    const kakera = list<ConvertKakera>(input.kakera, 'kakera', 2000).map((k) => {
      if (!k || typeof k.id !== 'string' || typeof k.body !== 'string' || typeof k.written_at !== 'string') {
        throw new ApiError(400, 'kakera は {id, body, written_at, show_time?} で送ってください');
      }
      return { id: k.id, body: k.body, written_at: k.written_at, show_time: k.show_time === true };
    });
    const docs = list<DocView>(input.docs, 'docs');
    for (const d of docs) {
      if (!d || typeof d.seg !== 'string' || typeof d.kind !== 'string' || !Array.isArray(d.refs) || !Array.isArray(d.lost_choices)) {
        throw new ApiError(400, 'docs は name-choice が返した形で送ってください');
      }
    }
    const photos = parsePhotoChoices(input.photos ?? []);
    if (!photos) throw new ApiError(400, 'photos は並びで送ってください');
    return json(
      convertView({
        katachi_date: str(input.katachi_date, 'katachi_date'),
        kakera,
        order: strings(input.order, 'order'),
        title: str(input.title, 'title'),
        description: typeof input.description === 'string' ? input.description : '',
        entries: list<NameEntry>(input.entries, 'entries'),
        docs,
        photos,
        cards: cardsOf(input.cards),
      })
    );
  });
