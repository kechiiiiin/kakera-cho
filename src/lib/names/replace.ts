// 公開名変換（日記に書き出すときだけ、辞書で名前を置き換える）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。データを返すだけ。
//
// 規則（設計「公開名変換設計」）:
//  1. 最長一致・左から一回きり。置き換えた結果をもう一度置き換えない
//  2. 置き換えない: 裸の URL・リンク先・画像の URL。
//     置き換える: リンクの表示文字・画像記法の代替文字（触らないと公開 HTML の alt に残る）・リンクの title
//  3. 例外は「自分自身へ置き換える項目」（source === target）。長い語から当てるので、例外の語の中の短い名前には当たらない
//  4. タイトルにも同じ規則で当てる
//
// ⚠️⚠️ ここの「URL の範囲」は、公開側（astro-blog の Markdown・remark-gfm の autolink literal）と
// **同じ区切り**で判定する専用のもの。かけら帳の表示用 `matchBareUrl`（ASCII だけで切る）を**流用しない**。
// 流用すると、日本語を含む URL の途中から先を「URL の外」と見なして置き換え、公開後のリンクを壊す。
// 手本: micromark-extension-gfm-autolink-literal 2.1.0 の tokenizeProtocolAutolink / tokenizeWwwAutolink。

export interface NameEntry {
  id: string;
  source: string;
  /** 例外は source と同じ文字列 */
  target: string;
  updated_at?: string;
}

export type ChoiceAction = 'approve' | 'edit' | 'reject';

/** 日記の説明文の選択の seg（'title' と同じく予約語。かけらの id＝ULID の大文字英数字とは衝突しない）。 */
export const DESCRIPTION_SEG = 'description';

/** 辞書に当たった箇所。pos は原本（置き換える前の文字列）の中の位置（UTF-16 の添字）。 */
export interface NameHit {
  pos: number;
  source: string;
  target: string;
  /** 例外（source === target）。押せない・選べない */
  exception: boolean;
}

export interface Span {
  start: number;
  end: number;
}

/**
 * 本文を「置き換えてよい範囲」と「触らない範囲」に切った列。
 * link / image は中に置き換えてよい範囲（表示文字・代替文字・title）を持つ。
 */
export type NameToken =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'url'; start: number; end: number }
  | { kind: 'raw'; start: number; end: number }
  | { kind: 'link'; start: number; end: number; label: NameToken[]; href: string; title: Span | null }
  | { kind: 'image'; start: number; end: number; alt: NameToken[]; url: string; title: Span | null };

/* ---------------- 文字の種類（micromark-util-character と同じ定義） ---------------- */

const UNICODE_PUNCT = /\p{P}|\p{S}/u;
const UNICODE_WS = /\s/;

function isAsciiAlpha(c: string): boolean {
  return /^[A-Za-z]$/.test(c);
}
function isAsciiControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
function isWs(c: string): boolean {
  return UNICODE_WS.test(c);
}
function isPunct(c: string): boolean {
  return UNICODE_PUNCT.test(c);
}
/** i の位置の1文字（サロゲートペアは2単位まとめて）。末尾なら ''。 */
function charAt(text: string, i: number): string {
  if (i >= text.length) return '';
  const cp = text.codePointAt(i)!;
  return String.fromCodePoint(cp);
}
/** i の直前の1文字（サロゲートペアは2単位まとめて）。先頭なら ''。 */
function charBefore(text: string, i: number): string {
  if (i <= 0) return '';
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text.charAt(i - 1);
}

/* ---------------- 公開側と同じ URL の区切り（GFM autolink literal） ---------------- */

/** 末尾に付いても URL から外れる記号（tokenizeTrail）。 */
const TRAIL_CHARS = '!"\')*,.:;?_~';
/** path の途中で「ここから後ろが全部末尾の記号か」を確かめる記号（tokenizePath）。 */
const PATH_CHECK_CHARS = '!"&\')*,.:;<?]_~';

/**
 * i から後ろが「末尾の記号だけ → 空白・行末・`<`・文末」になっているか（tokenizeTrail）。
 * true なら i の手前で URL が終わる。
 */
function isTrail(text: string, i: number): boolean {
  let j = i;
  for (;;) {
    const c = charAt(text, j);
    if (c === '' || c === '<' || isWs(c)) return true;
    if (TRAIL_CHARS.includes(c)) {
      j += 1;
      continue;
    }
    if (c === '&') {
      // 文字参照（&amp; のような）ぶんは末尾の記号として読む
      let k = j + 1;
      if (!isAsciiAlpha(charAt(text, k))) return false;
      while (isAsciiAlpha(charAt(text, k))) k++;
      if (charAt(text, k) !== ';') return false;
      j = k + 1;
      continue;
    }
    if (c === ']') {
      const n = charAt(text, j + 1);
      if (n === '' || n === '(' || n === '[' || isWs(n)) return true;
      j += 1;
      continue;
    }
    return false;
  }
}

/** ドメイン部（tokenizeDomain）。読めた終わりの位置、読めなければ -1。 */
function readDomain(text: string, i: number): number {
  let j = i;
  let seen = false;
  let underscoreInLast = false;
  let underscoreInLastLast = false;
  for (;;) {
    const c = charAt(text, j);
    if (c === '.' || c === '_') {
      if (isTrail(text, j)) break;
      if (c === '_') underscoreInLast = true;
      else {
        underscoreInLastLast = underscoreInLast;
        underscoreInLast = false;
      }
      j += 1;
      continue;
    }
    if (c === '' || isWs(c) || (c !== '-' && isPunct(c))) break;
    seen = true;
    j += c.length;
  }
  if (underscoreInLastLast || underscoreInLast || !seen) return -1;
  return j;
}

/** パス部（tokenizePath）。空白まで。末尾の記号と釣り合わない閉じ括弧は外す。 */
function readPath(text: string, i: number): number {
  let j = i;
  let open = 0;
  let close = 0;
  for (;;) {
    const c = charAt(text, j);
    if (c === '' || isWs(c)) return j;
    if (c === '(') {
      open++;
      j += 1;
      continue;
    }
    if (c === ')' && close < open) {
      close++;
      j += 1;
      continue;
    }
    if (PATH_CHECK_CHARS.includes(c)) {
      if (isTrail(text, j)) return j;
      if (c === ')') close++;
      j += 1;
      continue;
    }
    j += c.length;
  }
}

/**
 * i の位置から、公開側が autolink にする URL の終わりを返す。URL でなければ -1。
 * ⚠️ 置き換え専用。表示用の matchBareUrl とは混ぜない。
 */
export function publicUrlEnd(text: string, i: number): number {
  const c = text.charAt(i);
  if (c === 'h' || c === 'H') {
    // 直前が ASCII の英字なら autolink にしない（previousProtocol）
    if (isAsciiAlpha(charBefore(text, i))) return -1;
    const m = /^https?:\/\//i.exec(text.slice(i, i + 8));
    if (!m) return -1;
    const after = i + m[0].length;
    const first = charAt(text, after);
    if (first === '' || isAsciiControl(first) || isWs(first) || isPunct(first)) return -1;
    const d = readDomain(text, after);
    if (d < 0) return -1;
    return readPath(text, d);
  }
  if (c === 'w' || c === 'W') {
    const prev = charBefore(text, i);
    if (!(prev === '' || '(*_[]~'.includes(prev) || isWs(prev))) return -1;
    if (!/^www\./i.test(text.slice(i, i + 4))) return -1;
    if (i + 4 >= text.length) return -1;
    const d = readDomain(text, i + 4);
    if (d < 0) return -1;
    return readPath(text, d);
  }
  return -1;
}

/* ---------------- リンク・画像の記法 ---------------- */

interface LinkParts {
  label: Span;
  dest: Span;
  href: string;
  title: Span | null;
  end: number;
}

/** 空行（段落の切れ目）か。 */
function blankLineAt(text: string, i: number): boolean {
  return text.charAt(i) === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 64));
}

function skipSpaces(text: string, i: number, allowNewline: boolean): number {
  let j = i;
  let newlines = 0;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === ' ' || c === '\t') {
      j++;
      continue;
    }
    if (c === '\n' && allowNewline && newlines === 0) {
      newlines++;
      j++;
      continue;
    }
    break;
  }
  return j;
}

/** `[ラベル](行き先 "title")` を i（`[` の位置）から読む。読めなければ null。 */
function matchLinkAt(text: string, i: number): LinkParts | null {
  if (text.charAt(i) !== '[') return null;
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '\\') {
      j++;
      continue;
    }
    if (blankLineAt(text, j)) return null;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= text.length || text.charAt(j + 1) !== '(') return null;
  const label = { start: i + 1, end: j };

  let k = skipSpaces(text, j + 2, true);
  let dest: Span;
  if (text.charAt(k) === '<') {
    const close = text.indexOf('>', k + 1);
    const nl = text.indexOf('\n', k + 1);
    if (close < 0 || (nl >= 0 && nl < close)) return null;
    dest = { start: k + 1, end: close };
    k = close + 1;
  } else {
    const s = k;
    let paren = 0;
    while (k < text.length) {
      const c = text.charAt(k);
      if (c === '\\' && k + 1 < text.length) {
        k += 2;
        continue;
      }
      if (isWs(c) || isAsciiControl(c)) break;
      if (c === '(') paren++;
      else if (c === ')') {
        if (paren === 0) break;
        paren--;
      }
      k++;
    }
    dest = { start: s, end: k };
  }

  let title: Span | null = null;
  const beforeTitle = k;
  k = skipSpaces(text, k, true);
  const q = text.charAt(k);
  if (k > beforeTitle && (q === '"' || q === "'" || q === '(')) {
    const closeCh = q === '(' ? ')' : q;
    let t = k + 1;
    while (t < text.length && text.charAt(t) !== closeCh) {
      if (text.charAt(t) === '\\') t++;
      if (blankLineAt(text, t)) return null;
      t++;
    }
    if (t >= text.length) return null;
    title = { start: k + 1, end: t };
    k = skipSpaces(text, t + 1, true);
  }
  if (text.charAt(k) !== ')') return null;
  return { label, dest, href: text.slice(dest.start, dest.end), title, end: k + 1 };
}

const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;

/**
 * 本文を置き換え用に切る。
 * @param inLabel リンクの表示文字の中（リンクと裸の URL は開かない。画像だけ開く）
 */
function tokenizeRange(text: string, from: number, to: number, inLabel: boolean): NameToken[] {
  const out: NameToken[] = [];
  let textStart = from;
  let i = from;

  const pushText = (end: number): void => {
    if (end > textStart) out.push({ kind: 'text', start: textStart, end });
  };

  while (i < to) {
    const c = text.charAt(i);

    // 打ち消し（\[ など）。記法の開始として読まない
    if (c === '\\' && i + 1 < to && ASCII_PUNCT.test(text.charAt(i + 1))) {
      i += 2;
      continue;
    }

    // 行頭の参照リンクの定義 `[id]: URL "title"` の URL は触らない
    if (!inLabel && c === '[' && (i === 0 || text.charAt(i - 1) === '\n')) {
      const def = /^\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/.exec(text.slice(i, to));
      if (def) {
        const destStart = i + def[0].length - def[1]!.length;
        pushText(destStart);
        out.push({ kind: 'raw', start: destStart, end: i + def[0].length });
        i = i + def[0].length;
        textStart = i;
        continue;
      }
    }

    // ![代替文字](画像の URL)
    if (c === '!' && text.charAt(i + 1) === '[') {
      const m = matchLinkAt(text, i + 1);
      if (m && m.end <= to) {
        pushText(i);
        out.push({
          kind: 'image',
          start: i,
          end: m.end,
          alt: tokenizeRange(text, m.label.start, m.label.end, true),
          url: m.href,
          title: m.title,
        });
        i = m.end;
        textStart = i;
        continue;
      }
    }

    // [表示文字](リンク先)
    if (!inLabel && c === '[') {
      const m = matchLinkAt(text, i);
      if (m && m.end <= to) {
        pushText(i);
        out.push({
          kind: 'link',
          start: i,
          end: m.end,
          label: tokenizeRange(text, m.label.start, m.label.end, true),
          href: m.href,
          title: m.title,
        });
        i = m.end;
        textStart = i;
        continue;
      }
    }

    // <https://…>（山括弧の autolink）
    if (!inLabel && c === '<') {
      const m = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.exec(text.slice(i, to));
      if (m) {
        pushText(i);
        out.push({ kind: 'url', start: i, end: i + m[0].length });
        i += m[0].length;
        textStart = i;
        continue;
      }
    }

    // 裸の URL（公開側の GFM autolink と同じ区切り）
    if (!inLabel && (c === 'h' || c === 'H' || c === 'w' || c === 'W')) {
      const end = publicUrlEnd(text, i);
      if (end > i && end <= to) {
        pushText(i);
        out.push({ kind: 'url', start: i, end });
        i = end;
        textStart = i;
        continue;
      }
    }

    i += charAt(text, i).length || 1;
  }
  pushText(to);
  return out;
}

export function tokenizeForNames(text: string): NameToken[] {
  return tokenizeRange(text, 0, text.length, false);
}

/** 置き換えてよい範囲（左から順）。 */
export function replaceableSpans(tokens: NameToken[]): Span[] {
  const out: Span[] = [];
  for (const t of tokens) {
    if (t.kind === 'text') out.push({ start: t.start, end: t.end });
    else if (t.kind === 'link') {
      out.push(...replaceableSpans(t.label));
      if (t.title) out.push(t.title);
    } else if (t.kind === 'image') {
      out.push(...replaceableSpans(t.alt));
      if (t.title) out.push(t.title);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------------- 当てる ---------------- */

/** 長い語から先に。同じ長さは文字列順（毎回同じ結果になるように）。空の語は捨てる。 */
export function sortDictionary(dict: NameEntry[]): NameEntry[] {
  return dict
    .filter((d) => d.source.length > 0)
    .slice()
    .sort((a, b) => b.source.length - a.source.length || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** 範囲の中で最長一致・左から一回きり。 */
function hitsInSpan(text: string, span: Span, sorted: NameEntry[], out: NameHit[]): void {
  let i = span.start;
  while (i < span.end) {
    let hit: NameEntry | null = null;
    for (const d of sorted) {
      if (i + d.source.length <= span.end && text.startsWith(d.source, i)) {
        hit = d;
        break;
      }
    }
    if (hit) {
      out.push({ pos: i, source: hit.source, target: hit.target, exception: hit.source === hit.target });
      i += hit.source.length;
    } else {
      i += charAt(text, i).length || 1;
    }
  }
}

export function findHits(text: string, dict: NameEntry[], tokens: NameToken[] = tokenizeForNames(text)): NameHit[] {
  const sorted = sortDictionary(dict);
  if (!sorted.length) return [];
  const out: NameHit[] = [];
  for (const span of replaceableSpans(tokens)) hitsInSpan(text, span, sorted, out);
  return out;
}

/* ---------------- 選択 ---------------- */

export interface NameChoice {
  pos: number;
  source: string;
  action: ChoiceAction;
  /** action が edit のときの言葉 */
  text?: string;
}

/** 手で直した言葉を整える（改行を落とし、前後の空白を落とし、長さを抑える）。空なら null。 */
export function cleanEditText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, 60).join('');
}

/** その箇所に効く選択。位置と置き換え元が一致しないもの・例外・中身の無い edit は辞書どおりに倒す。 */
export function effectiveChoice(hit: NameHit, choice: NameChoice | undefined): { action: ChoiceAction; text?: string } {
  if (hit.exception || !choice || choice.pos !== hit.pos || choice.source !== hit.source) return { action: 'approve' };
  if (choice.action === 'reject') return { action: 'reject' };
  if (choice.action === 'edit') {
    const t = cleanEditText(choice.text);
    if (!t || t === hit.target) return { action: 'approve' };
    return { action: 'edit', text: t };
  }
  return { action: 'approve' };
}

/** その箇所に出る言葉。 */
export function shownWord(hit: NameHit, choice: NameChoice | undefined): string {
  if (hit.exception) return hit.source;
  const c = effectiveChoice(hit, choice);
  if (c.action === 'reject') return hit.source;
  if (c.action === 'edit') return c.text!;
  return hit.target;
}

export interface ConvertResult {
  text: string;
  hits: NameHit[];
  /** 実際に効いた選択（辞書どおり以外）。位置は原本の位置 */
  applied: NameChoice[];
}

/**
 * 原本を置き換える。choices は pos をキーにした選択（無ければ全部辞書どおり）。
 * ⚠️ 書き出しでは、画面から届いた本文ではなく**原本**をこれに通す。
 *
 * @param drop 公開版から切り落とす範囲（原本の位置。出さない写真＝publish/photo-choice の hiddenPhotoSpans）。
 *   当たり箇所の計算と選択の照合は原本のまま行い、切り落とす範囲に掛かった当たり箇所は出さない
 *   （applied にも入れない＝出さない写真の代替文字に残った「拒否」で念押しを求めない）。
 *   位置で持つ名前の選択を崩さないよう、写真を除くのは**この一回の走査の中だけ**で行う。
 */
export function convertText(
  text: string,
  dict: NameEntry[],
  choices?: Map<number, NameChoice>,
  drop: Span[] = []
): ConvertResult {
  const hits = findHits(text, dict);
  const applied: NameChoice[] = [];
  const ops: { start: number; end: number; put: string }[] = drop.map((d) => ({ start: d.start, end: d.end, put: '' }));
  for (const h of hits) {
    const end = h.pos + h.source.length;
    if (drop.some((d) => h.pos < d.end && d.start < end)) continue;
    const choice = choices?.get(h.pos);
    const eff = effectiveChoice(h, choice);
    if (!h.exception && eff.action !== 'approve') {
      applied.push({ pos: h.pos, source: h.source, action: eff.action, ...(eff.text ? { text: eff.text } : {}) });
    }
    ops.push({ start: h.pos, end, put: shownWord(h, choice) });
  }
  ops.sort((a, b) => a.start - b.start);
  let out = '';
  let cur = 0;
  for (const op of ops) {
    if (op.start < cur) continue; // drop はまとめ済み・当たり箇所は drop と重ならないので来ない（念のため）
    out += text.slice(cur, op.start) + op.put;
    cur = op.end;
  }
  return { text: out + text.slice(cur), hits, applied };
}

/** 選択の列を pos のキーに引ける形にする。 */
export function choiceMap(choices: NameChoice[] | undefined): Map<number, NameChoice> {
  const m = new Map<number, NameChoice>();
  for (const c of choices ?? []) m.set(c.pos, c);
  return m;
}
