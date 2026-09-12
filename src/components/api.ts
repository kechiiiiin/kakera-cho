// 画面から API を叩くだけの薄い層（iOS から同じ API を使うので、ここに業務の判断を書かない）。

import type { Kakera, KatachiDetail, KatachiSummary, SearchResult } from '../lib/kakera/types';

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
  nagare: () => req<{ kakera: Kakera[] }>('/api/kakera?unassigned=1').then((r) => r.kakera),

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

  publishNikki: (katachiId: string, input: { kakera_ids: string[]; title?: string }) =>
    req<{ ok: true; path: string; slug: string }>(`/api/katachi/${katachiId}/nikki`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  uploadPhoto: (form: FormData) =>
    req<{ key: string; url: string }>('/api/photo', { method: 'POST', body: form }),

  search: (q: string) =>
    req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
};
