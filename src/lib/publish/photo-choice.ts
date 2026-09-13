// 写真ごとの「日記に出す／出さない」（公開名変換設計「追加決定: 変換ページで写真も選ぶ」）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。データを返すだけ。
//
// 決まり:
//  - 開いた時点では全部「出す」。「出さない」だけを選択として持つ（名前の承認と同じ流儀）
//  - 選択は本文中の位置ではなく**写真の key（kakera-photos の key）**に紐づける。
//    かけらの文章を直しても白紙に戻らない。写真を本文から消せば、その選択は自然に効かなくなる
//  - 出さない写真は公開版の本文から画像記法ごと除く（代替文字も一緒に消える）
//
// ⚠️⚠️ 名前の置き換えとの順番:
//  名前の選択は「原本の中の位置」で持っている。写真を先に除いて本文を縮めると、後ろの当たり箇所の
//  位置が全部ずれて、名前の選択が位置照合で落ちる（＝辞書どおりに倒れて、拒否や手直しが消える）。
//  だから写真を除く範囲も**原本の位置のまま**計算し、名前の置き換えと**同じ一回の走査**で切り落とす
//  （convertText の drop）。当たり箇所の計算・選択の照合は原本に対して行うので、写真を出す／出さないで
//  名前の選択が崩れることはない。
//  「置き換えた後の本文から画像記法を正規表現で探して消す」形にしないのは、手で直した言葉が代替文字に
//  入ると（`]` を含む等）画像記法として読めなくなり、出さないはずの写真が残り得るため。

import {
  convertText,
  tokenizeForNames,
  type ConvertResult,
  type NameChoice,
  type NameEntry,
  type NameToken,
  type Span,
} from '../names/replace';
import { keyFromPhotoUrl } from './photos';

/** 本文に出てくる写真 1 枚ぶん（原本の位置）。 */
export interface PhotoSpot {
  start: number;
  end: number;
  /** kakera-photos の key */
  key: string;
}

/** 名前の置き換え用の切れから、かけら帳が置いた写真（/api/photo/…）を拾う。リンクの表示文字の中も見る。 */
export function photoSpots(tokens: NameToken[]): PhotoSpot[] {
  const out: PhotoSpot[] = [];
  const walk = (list: NameToken[]): void => {
    for (const t of list) {
      if (t.kind === 'image') {
        const key = keyFromPhotoUrl(t.url.trim());
        if (key) out.push({ start: t.start, end: t.end, key });
        walk(t.alt);
      } else if (t.kind === 'link') {
        walk(t.label);
      }
    }
  };
  walk(tokens);
  return out.sort((a, b) => a.start - b.start);
}

/** 本文に出てくる写真の key（重複なし・出てくる順）。 */
export function photoKeysIn(text: string, tokens: NameToken[] = tokenizeForNames(text)): string[] {
  return [...new Set(photoSpots(tokens).map((p) => p.key))];
}

/** 重なる・接する範囲をまとめる。 */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

const isHSpace = (c: string): boolean => c === ' ' || c === '\t';

/**
 * 出さない写真を除くために切り落とす範囲（原本の位置）。
 *
 * - 行が出さない写真（と空白）だけなら、**行ごと**落とす
 * - 文の途中の写真なら、画像記法とその片側の空白だけを落とす
 * - 行を落とした跡に空行が重なるなら、重なったぶんの空行も落とす（段落の切れ目は一つ残す）。
 *   区切り線 `---` の前後の空行は composeBody（ensureHrBlankLines）が必ず確保し直すので、ここで壊れない
 */
export function hiddenPhotoSpans(
  text: string,
  hidden: ReadonlySet<string>,
  tokens: NameToken[] = tokenizeForNames(text)
): Span[] {
  if (!hidden.size) return [];
  const spots = photoSpots(tokens).filter((p) => hidden.has(p.key));
  if (!spots.length) return [];

  // 空白だけを挟んで並んだ出さない写真は一つにまとめる（`![](a) ![](b)` を両方出さない → 行ごと落とす）
  const groups: Span[] = [];
  for (const s of mergeSpans(spots)) {
    const last = groups[groups.length - 1];
    if (last && /^[ \t]*$/.test(text.slice(last.end, s.start))) last.end = s.end;
    else groups.push({ start: s.start, end: s.end });
  }

  // 行の頭の位置
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charAt(i) === '\n') lineStarts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineCount = lineStarts.length;
  const lineEnd = (n: number): number => (n + 1 < lineCount ? lineStarts[n + 1]! - 1 : text.length);
  const isBlankLine = (n: number): boolean => /^[ \t]*$/.test(text.slice(lineStarts[n]!, lineEnd(n)));

  const inline: Span[] = [];
  const deleted = new Set<number>();
  for (const g of groups) {
    let a = g.start;
    let b = g.end;
    while (a > 0 && isHSpace(text.charAt(a - 1))) a--;
    while (b < text.length && isHSpace(text.charAt(b))) b++;
    const atLineStart = a === 0 || text.charAt(a - 1) === '\n';
    const atLineEnd = b === text.length || text.charAt(b) === '\n';
    if (atLineStart && atLineEnd) {
      for (let n = lineOf(a); n <= lineOf(b); n++) deleted.add(n);
    } else if (atLineStart) {
      inline.push({ start: g.start, end: b });
    } else {
      inline.push({ start: a, end: g.end });
    }
  }

  // 空行の重なりを解く（落とした行の前後がどちらも空行か文の端なら、空行を一つ落とす。変わらなくなるまで）
  const runs = (): [number, number][] => {
    const out: [number, number][] = [];
    for (let n = 0; n < lineCount; n++) {
      if (!deleted.has(n)) continue;
      let m = n;
      while (m + 1 < lineCount && deleted.has(m + 1)) m++;
      out.push([n, m]);
      n = m;
    }
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, j] of runs()) {
      const bof = i === 0;
      const eof = j === lineCount - 1;
      if (bof && eof) continue;
      const prevBlank = bof || isBlankLine(i - 1);
      const nextBlank = eof || isBlankLine(j + 1);
      if (!prevBlank || !nextBlank) continue;
      if (!eof) deleted.add(j + 1);
      else deleted.add(i - 1);
      changed = true;
      break;
    }
  }

  const lineSpans: Span[] = runs().map(([i, j]) => {
    if (j === lineCount - 1) return { start: i > 0 ? lineStarts[i]! - 1 : 0, end: text.length };
    return { start: lineStarts[i]!, end: lineStarts[j + 1]! };
  });
  return mergeSpans([...lineSpans, ...inline]);
}

/** その範囲が、切り落とす範囲のどれかと重なるか。 */
export function overlapsAny(start: number, end: number, drops: Span[]): boolean {
  return drops.some((d) => start < d.end && d.start < end);
}

/**
 * 公開版の本文を作る（名前の置き換え＋出さない写真を除く）。
 * ⚠️ 画面の「公開される姿」「Markdown」と書き出し（nikki.ts）で、必ず同じこれを通す。
 * ⚠️ 原本（D1 のかけら）を渡す。位置は全部原本の位置のまま扱う（冒頭の注記）。
 */
export function convertForPublish(
  text: string,
  dict: NameEntry[],
  choices: Map<number, NameChoice> | undefined,
  hidden: ReadonlySet<string>
): ConvertResult {
  return convertText(text, dict, choices, hiddenPhotoSpans(text, hidden));
}

/* ---------------- 選択の形 ---------------- */

/** 「日記に出さない」写真 1 枚ぶん。出す写真は選択を持たない。 */
export interface PhotoChoice {
  kakera_id: string;
  key: string;
}

/** 画面・API から届いた写真の選択を形だけ検める（中身の突き合わせは validatePhotoChoices）。 */
export function parsePhotoChoices(raw: unknown): PhotoChoice[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const out: PhotoChoice[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.kakera_id !== 'string' || typeof o.key !== 'string') continue;
    out.push({ kakera_id: o.kakera_id, key: o.key });
  }
  return out;
}

/**
 * 写真の選択を**原本**と突き合わせる。渡したかけらの原本に実在する写真の key だけ残す（重複は一つに）。
 * 画面から届いた本文は見ない。
 */
export function validatePhotoChoices(kakera: { id: string; body: string }[], choices: PhotoChoice[]): PhotoChoice[] {
  const keysOf = new Map(kakera.map((k) => [k.id, new Set(photoKeysIn(k.body))]));
  const seen = new Set<string>();
  const out: PhotoChoice[] = [];
  for (const c of choices) {
    const keys = keysOf.get(c.kakera_id);
    if (!keys || !keys.has(c.key)) continue;
    const id = `${c.kakera_id}\n${c.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kakera_id: c.kakera_id, key: c.key });
  }
  return out;
}

/** かけらの id → 出さない写真の key。 */
export function hiddenKeysOf(choices: PhotoChoice[], kakeraId: string): Set<string> {
  return new Set(choices.filter((c) => c.kakera_id === kakeraId).map((c) => c.key));
}
