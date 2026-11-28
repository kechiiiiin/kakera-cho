// iPhone 版（ios/・SwiftUI）に渡す、文字の決まりの結果（かけら帳ネイティブ化設計）。
// Web 版の画面が手元で計算しているもの（抜粋・言葉の確認・名前の試し書き）を、同じ関数でサーバが返す。
// 名前・言葉の決まり（replace.ts・markdown.ts の wordCandidates など）を Swift に写さないため。
// ⚠️ 状態は持たない・D1 も読まない。純関数。

import type { LinkCards } from '../card/types';
import { candidateContext, textForPick } from '../card/pick';
import { buildRealShape, resolveShape, type ResolvedSpan } from '../names/doc';
import type { NameEntry } from '../names/replace';
import { planWordLinks } from '../kakera/word-links';

/** 選ぶ所の抜粋（textForPick）を、本文ごとに。 */
export function pickTexts(bodies: readonly string[], cards?: LinkCards): string[] {
  return bodies.map((b) => textForPick(b, cards));
}

export interface WordPlanRow {
  key: string;
  kakera_id: string;
  word: string;
  /** 本文の中の位置（UTF-16 の単位） */
  start: number;
  end: number;
  /** 確認の行に添える前後の文（candidateContext） */
  before: string;
  after: string;
}

/**
 * 「かたちにする」のときの、既にページがある言葉の確認の行（ComposeScreen.tsx の planWordLinks と candidateContext）。
 * かけらは渡した順（書いた順）。
 */
export function wordPlan(
  kakera: readonly { id: string; body: string }[],
  pages: readonly string[],
  cards?: LinkCards
): WordPlanRow[] {
  const full = kakera.map((k) => ({ id: k.id, body: k.body, written_at: '', katachi_id: null, updated_at: '' }));
  return planWordLinks(full, pages).map((r) => {
    const c = candidateContext(r.body, r, cards);
    return { key: r.key, kakera_id: r.kakera_id, word: r.word, start: r.start, end: r.end, before: c.before, after: c.after };
  });
}

/** 名前の辞書の試し書き（NameMapScreen.tsx と同じく、記号にしてから辞書どおりに解く）。 */
export function nameTry(text: string, entries: NameEntry[]): { text: string; spans: ResolvedSpan[] } {
  let seq = 0;
  const r = resolveShape(
    buildRealShape(text, entries, () => `try${++seq}`),
    entries
  );
  return { text: r.text, spans: r.spans };
}
