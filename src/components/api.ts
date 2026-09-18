// 画面から API を叩くだけの薄い層（iOS から同じ API を使うので、ここに業務の判断を書かない）。

import type { Kakera, KatachiDetail, KatachiSummary, SearchResult } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import type { DocView } from '../lib/names/doc-db';
import type { ChoiceAction, NameRef } from '../lib/names/doc';
import type { NameEntry } from '../lib/names/replace';
import type { PhotoChoice } from '../lib/publish/photo-choice';
import type { PublishBodyView } from '../lib/publish/publish-body';

/** 記号一つの選択。 */
export interface RefChoiceInput {
  ref_id: string;
  action: ChoiceAction;
  /** action が edit のときの言葉 */
  text?: string;
}

export interface PublishNikkiInput {
  kakera_ids: string[];
  title: string;
  /** この日記に使う文書の全記号ぶんの選択 */
  choices: RefChoiceInput[];
  /** 日記に出さない写真（サーバが原本か日記用の文に実在する key だけ当てる） */
  photos: PhotoChoice[];
  /** 実名のまま出る箇所があると念押しで確かめたか（無いのに拒否が残っていればサーバが 409） */
  confirm_real_names: boolean;
  /** 開いたときの文書の版（開いた後に変わっていればサーバが 409） */
  doc_revs: { doc_id: string; rev: string }[];
  /** 開いたときの辞書の印（開いた後に変わっていればサーバが 409） */
  dict_rev: string;
}

export interface NameEntryInput {
  source: string;
  target: string;
  exception: boolean;
}

export interface NameChoiceLoad {
  entries: NameEntry[];
  /** 日記に使うタイトル（入力が空ならかたちの題） */
  title: string;
  /** D1 に保存してある日記の説明文（原本・改行は畳み済み）。空なら frontmatter に書かない */
  description: string;
  dict_rev: string;
  /** タイトル・説明・かけらごとの原本の文書と日記用の文書 */
  docs: DocView[];
}

export class ApiFailure extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const fromBody =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : '';
    throw new ApiFailure(res.status, fromBody || `通信に失敗しました（${res.status}）`);
  }
  return data as T;
}

export const api = {
  /** 流れ＋そこに出てくる URL のリンクカード（同じ往復で届く） */
  nagare: () =>
    req<{ kakera: Kakera[]; cards?: LinkCards }>('/api/kakera?unassigned=1').then((r) => ({
      kakera: r.kakera,
      cards: r.cards ?? {},
    })),

  createKakera: (input: { id: string; body: string; written_at: string }) =>
    req<{ kakera: Kakera }>('/api/kakera', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.kakera),

  updateKakera: (id: string, body: string) =>
    req<{ kakera: Kakera }>(`/api/kakera/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }).then(
      (r) => r.kakera
    ),

  deleteKakera: (id: string) => req<{ ok: true }>(`/api/kakera/${id}`, { method: 'DELETE' }),

  katachiList: () => req<{ katachi: KatachiSummary[] }>('/api/katachi').then((r) => r.katachi),

  katachi: (id: string) => req<KatachiDetail>(`/api/katachi/${id}`),

  createKatachi: (input: { id: string; date: string; title: string; kakera_ids: string[] }) =>
    req<KatachiDetail>('/api/katachi', { method: 'POST', body: JSON.stringify(input) }),

  updateKatachi: (id: string, patch: { date?: string; title?: string; description?: string; move_nikki?: boolean }) =>
    req<KatachiDetail>(`/api/katachi/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  dissolveKatachi: (id: string) => req<{ ok: true }>(`/api/katachi/${id}`, { method: 'DELETE' }),

  /** 既にあるかたちへかけらを足す（並びはサーバが書いた順で決める）。戻りはかたちの詳細 */
  addKakeraToKatachi: (katachiId: string, kakeraIds: string[]) =>
    req<KatachiDetail>(`/api/katachi/${katachiId}/kakera`, {
      method: 'POST',
      body: JSON.stringify({ kakera_ids: kakeraIds }),
    }),

  detachKakera: (katachiId: string, kakeraId: string) =>
    req<{ kakera: Kakera }>(`/api/katachi/${katachiId}/kakera/${kakeraId}`, { method: 'DELETE' }),

  /** 本文とタイトルはサーバが D1 の文書から解き直す。送るのは並び・タイトルの入力・選択・版だけ */
  publishNikki: (katachiId: string, input: PublishNikkiInput) =>
    req<{ ok: true; path: string; slug: string }>(`/api/katachi/${katachiId}/nikki`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /* ---- 公開名変換 ---- */

  nameMap: () => req<{ entries: NameEntry[] }>('/api/name-map').then((r) => r.entries),

  addNameEntry: (input: NameEntryInput) =>
    req<{ entry: NameEntry }>('/api/name-map', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.entry),

  updateNameEntry: (id: string, input: NameEntryInput) =>
    req<{ entry: NameEntry }>(`/api/name-map/${id}`, { method: 'PATCH', body: JSON.stringify(input) }).then(
      (r) => r.entry
    ),

  deleteNameEntry: (id: string) => req<{ ok: true }>(`/api/name-map/${id}`, { method: 'DELETE' }),

  /** 変換ページを開くとき（タイトルを URL に載せないので POST）。文書の同期はここで走る */
  loadNameChoices: (katachiId: string, input: { kakera_ids: string[]; title: string }) =>
    req<NameChoiceLoad>(`/api/katachi/${katachiId}/name-choice`, { method: 'POST', body: JSON.stringify(input) }),

  /** 記号一つの選択を保存する */
  saveNameChoice: (katachiId: string, input: RefChoiceInput) =>
    req<{ ref: NameRef }>(`/api/katachi/${katachiId}/name-choice`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }).then((r) => r.ref),

  /* ---- 日記用に直した文（原本は触らない。書き出しはサーバが D1 から解き直す） ---- */

  loadPublishBodies: (katachiId: string) =>
    req<{ bodies: PublishBodyView[]; cards?: LinkCards }>(`/api/katachi/${katachiId}/publish-body`).then((r) => ({
      bodies: r.bodies,
      cards: r.cards ?? {},
    })),

  /** base = 欄を開いたときの文。原本と同じになったら publish は null（書き換えを持たない） */
  savePublishBody: (katachiId: string, kakeraId: string, input: { base: string; text: string }) =>
    req<{ publish: DocView | null; kakera: DocView | null; cards?: LinkCards }>(
      `/api/katachi/${katachiId}/publish-body/${kakeraId}`,
      { method: 'PUT', body: JSON.stringify(input) }
    ).then((r) => ({ publish: r.publish, kakera: r.kakera, cards: r.cards ?? {} })),

  /** 「書き換えを使う」（原本が変わった後も書き換えで出す） */
  acceptPublishBody: (katachiId: string, kakeraId: string) =>
    req<{ publish_body: PublishBodyView }>(`/api/katachi/${katachiId}/publish-body/${kakeraId}`, {
      method: 'PATCH',
    }).then((r) => r.publish_body),

  /** 書き換えを捨てて原本に戻す */
  deletePublishBody: (katachiId: string, kakeraId: string) =>
    req<{ ok: true; removed: boolean }>(`/api/katachi/${katachiId}/publish-body/${kakeraId}`, { method: 'DELETE' }),

  /* ---- 写真の出す／出さない ---- */

  loadPhotoChoices: (katachiId: string, input: { kakera_ids: string[] }) =>
    req<{ photos: PhotoChoice[] }>(`/api/katachi/${katachiId}/photo-choice`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.photos),

  savePhotoChoices: (katachiId: string, input: { kakera_ids: string[]; photos: PhotoChoice[] }) =>
    req<{ ok: true; photos: PhotoChoice[] }>(`/api/katachi/${katachiId}/photo-choice`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  uploadPhoto: (form: FormData) =>
    req<{ key: string; url: string }>('/api/photo', { method: 'POST', body: form }),

  search: (q: string) =>
    req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
};
