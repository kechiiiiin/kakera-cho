// 画面から API を叩くだけの薄い層（iOS から同じ API を使うので、ここに業務の判断を書かない）。

import type { Kakera, KatachiDetail, KatachiSummary, SearchResult } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import type { LoadedChoices, SegChoice } from '../lib/names/db';
import type { NameEntry } from '../lib/names/replace';

export interface PublishNikkiInput {
  kakera_ids: string[];
  title: string;
  choices: SegChoice[];
  /** 実名のまま出る箇所があると念押しで確かめたか（無いのに拒否が残っていればサーバが 409） */
  confirm_real_names: boolean;
}

export interface NameEntryInput {
  source: string;
  target: string;
  exception: boolean;
}

export interface NameChoiceLoad extends LoadedChoices {
  entries: NameEntry[];
  /** 日記に使うタイトル（入力が空ならかたちの題） */
  title: string;
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

  updateKatachi: (id: string, patch: { date?: string; title?: string; order?: string[] }) =>
    req<KatachiDetail>(`/api/katachi/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  dissolveKatachi: (id: string) => req<{ ok: true }>(`/api/katachi/${id}`, { method: 'DELETE' }),

  detachKakera: (katachiId: string, kakeraId: string) =>
    req<{ kakera: Kakera }>(`/api/katachi/${katachiId}/kakera/${kakeraId}`, { method: 'DELETE' }),

  /** 本文とタイトルはサーバが原本から置き換え直す。送るのは並び・タイトルの入力・選択だけ */
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

  /** 変換ページを開くとき（タイトルを URL に載せないので POST） */
  loadNameChoices: (katachiId: string, input: { kakera_ids: string[]; title: string }) =>
    req<NameChoiceLoad>(`/api/katachi/${katachiId}/name-choice`, { method: 'POST', body: JSON.stringify(input) }),

  saveNameChoices: (katachiId: string, input: { kakera_ids: string[]; title: string; choices: SegChoice[] }) =>
    req<{ ok: true; choices: SegChoice[] }>(`/api/katachi/${katachiId}/name-choice`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  uploadPhoto: (form: FormData) =>
    req<{ key: string; url: string }>('/api/photo', { method: 'POST', body: form }),

  search: (q: string) =>
    req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
};
