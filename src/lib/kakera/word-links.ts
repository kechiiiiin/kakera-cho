// 「かたちにする」のときの、既にページがある言葉の確認（かけら言葉リンク設計 §3.5）。画面に依存しない。

import type { Kakera } from './types';
import { wordCandidates, wrapWordCandidates, type WordCandidate } from '../markdown';

/** 確認の1行。 */
export interface WordLinkRow extends WordCandidate {
  /** 行の印（`かけらの id:言葉`。かけらごと・言葉ごとに1か所なので重ならない） */
  key: string;
  kakera_id: string;
  body: string;
}

/** 確認の行を組む。かけらは渡した順（書いた順）、同じかけらの中は本文の中の順。 */
export function planWordLinks(kakera: readonly Kakera[], pages: readonly string[]): WordLinkRow[] {
  return kakera.flatMap((k) =>
    wordCandidates(k.body, pages).map((c) => ({ ...c, key: `${k.id}:${c.word}`, kakera_id: k.id, body: k.body }))
  );
}

export interface WordLinkEdit {
  id: string;
  body: string;
}

/** 選んだ行を、かけらごとの新しい本文にする（選んだ行の無いかけらは含めない）。 */
export function wordLinkEdits(rows: readonly WordLinkRow[]): WordLinkEdit[] {
  const byId = new Map<string, WordLinkRow[]>();
  for (const r of rows) byId.set(r.kakera_id, [...(byId.get(r.kakera_id) ?? []), r]);
  return [...byId.entries()].map(([id, list]) => ({ id, body: wrapWordCandidates(list[0]!.body, list) }));
}

/**
 * 本文の直しを順番に当てる。失敗したらそこで止めて投げる（呼ぶ側はかたちを作らない。直し終えたかけらは囲まれたまま）。
 * ⚠️ 並列にしない（同じかたちの控えが同時に書かれないように）。
 */
export async function applyWordLinks(edits: readonly WordLinkEdit[], patch: (id: string, body: string) => Promise<unknown>): Promise<void> {
  for (const e of edits) await patch(e.id, e.body);
}
