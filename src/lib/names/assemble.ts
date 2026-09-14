// 書き出す日記の中身を、名前の文書から組む（公開名変換設計・記号方式の同期と書き出し §2・§3）。純関数。
// ⚠️ 画面の「公開される姿」「Markdown」と書き出し（nikki.ts）で、必ず同じこれを通す。
//
// 順番（原則 6）: 記号を解く → 出さない写真を解いた後の文から除く → 取り残しの検査。
// 位置方式では写真を名前と一回の走査で除かないと選択が落ちたが、記号は文と一緒に動くので解いてから除いてよい。
// 止める（NameDocError → 409）: 形の崩れ／記号が解けない／実名の文書を実名で解いても元の文と一致しない／
// 記号になっていない実名が残った／出さない写真の key が残った／リンク・画像の記法が崩れた。

import {
  NameDocError,
  realTextOf,
  resolveShape,
  shapeProblem,
  dictMap,
  type NameDocShape,
  type ResolvedSpan,
} from './doc';
import { findHits, tokenizeForNames, type NameEntry, type NameToken, type Span } from './replace';
import { hiddenPhotoSpans } from '../publish/photo-choice';

export interface AssemblePart {
  seg: string;
  /** 知らせに出す段の名前（タイトル・説明・かけら n） */
  label: string;
  /** null = 形が崩れている */
  shape: NameDocShape | null;
  /** 実名の文書（原本・タイトル・説明）なら、実名で解いたときに一致すべき今の文 */
  expected?: string;
  /** 本文なら true（置き換えた言葉を Markdown として打ち消し、出さない写真を除く） */
  body: boolean;
  /** 出さない写真の key */
  hidden?: ReadonlySet<string>;
}

export interface AssembledPart {
  seg: string;
  label: string;
  /** 書き出す文（本文は写真を除いた後・写真 URL の差し替えと空行の保持の前） */
  text: string;
  /** 書き出す文の中の記号の出力範囲（除いた写真に掛かった記号は入らない） */
  spans: ResolvedSpan[];
}

export interface Assembled {
  title: AssembledPart;
  description: AssembledPart | null;
  bodies: AssembledPart[];
  /** 書き出す文に残った「拒否」 */
  rejects: { seg: string; label: string; id: string; source: string }[];
}

function snippet(text: string, pos: number, len: number): string {
  const a = Math.max(0, pos - 10);
  const b = Math.min(text.length, pos + len + 10);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

/** リンクと画像の入れ子の並び（記法が崩れていないかを見る）。 */
function structureOf(tokens: NameToken[]): string {
  return tokens
    .map((t) => {
      if (t.kind === 'link') return `L(${structureOf(t.label)})`;
      if (t.kind === 'image') return `I(${structureOf(t.alt)})`;
      return '';
    })
    .join('');
}

/** 範囲を切り落とす。残った記号の範囲は詰めた位置に写し、切り落とす範囲に掛かった記号は捨てる。 */
function applyDrops(text: string, spans: ResolvedSpan[], drops: Span[]): { text: string; spans: ResolvedSpan[] } {
  if (!drops.length) return { text, spans };
  let out = '';
  let cur = 0;
  for (const d of drops) {
    out += text.slice(cur, d.start);
    cur = d.end;
  }
  out += text.slice(cur);
  const shift = (p: number): number => drops.reduce((n, d) => (d.end <= p ? n + (d.end - d.start) : n), 0);
  const kept = spans
    .filter((s) => !drops.some((d) => s.start < d.end && d.start < s.end))
    .map((s) => ({ ...s, start: s.start - shift(s.start), end: s.end - shift(s.start) }));
  return { text: out, spans: kept };
}

export function assemblePart(part: AssemblePart, dict: NameEntry[]): AssembledPart {
  const stop = (why: string): never => {
    throw new NameDocError(`${part.label}の名前の記号が${why}。開き直してください。`);
  };
  if (!part.shape) return stop('読めません（形が崩れています）');
  const problem = shapeProblem(part.shape);
  if (problem) return stop(`読めません（${problem}）`);
  const idx = dictMap(dict);

  let real: string;
  try {
    real = realTextOf(part.shape).text;
  } catch {
    return stop('読めません');
  }
  if (part.expected !== undefined && real !== part.expected) stop('元の文と合いません');

  let resolved: { text: string; spans: ResolvedSpan[] };
  try {
    resolved = resolveShape(part.shape, idx, { escape: part.body });
  } catch (e) {
    return stop(`解けません（${e instanceof Error ? e.message : String(e)}）`);
  }

  if (part.body && structureOf(tokenizeForNames(resolved.text)) !== structureOf(tokenizeForNames(real))) {
    throw new NameDocError(`${part.label}で、置き換えた言葉がリンクや画像の記法を崩しています。手で直した言葉を見直してください。`);
  }

  const hidden = part.hidden ?? new Set<string>();
  const drops = part.body && hidden.size ? hiddenPhotoSpans(resolved.text, hidden) : [];
  const out = applyDrops(resolved.text, resolved.spans, drops);

  // 記号になっていない実名（例外でない当たりが、一つの記号の出力範囲に丸ごと入っていない）
  for (const h of findHits(out.text, dict)) {
    if (h.exception) continue;
    const end = h.pos + h.source.length;
    if (out.spans.some((s) => s.start <= h.pos && end <= s.end)) continue;
    throw new NameDocError(`記号になっていない名前があります（${part.label}「${snippet(out.text, h.pos, h.source.length)}」）。開き直してください。`);
  }
  // 出さない写真の取り残し（手で直した言葉で記法が崩れた等）
  for (const key of hidden) {
    if (out.text.includes(`/api/photo/${key}`)) {
      throw new NameDocError(`${part.label}に、日記に出さない写真が残っています。手で直した言葉を見直してください。`);
    }
  }
  return { seg: part.seg, label: part.label, text: out.text, spans: out.spans };
}

/** タイトル・説明・本文を組む。どこかで止まれば NameDocError。 */
export function assembleNikki(
  parts: { title: AssemblePart; description: AssemblePart | null; bodies: AssemblePart[] },
  dict: NameEntry[]
): Assembled {
  const title = assemblePart({ ...parts.title, body: false }, dict);
  const description = parts.description ? assemblePart({ ...parts.description, body: false }, dict) : null;
  const bodies = parts.bodies.map((p) => assemblePart({ ...p, body: true }, dict));
  const rejects: Assembled['rejects'] = [];
  for (const p of [title, ...(description ? [description] : []), ...bodies]) {
    for (const s of p.spans) {
      if (s.status === 'reject') rejects.push({ seg: p.seg, label: p.label, id: s.id, source: s.source });
    }
  }
  return { title, description, bodies, rejects };
}
