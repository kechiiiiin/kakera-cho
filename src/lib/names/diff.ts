// 文字の差分（Myers）。名前の記号を「前の文 → 今の文」で追うために使う（公開名変換設計・記号方式の同期と書き出し §1）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。
//
// - 差分はコードポイント単位で取り（サロゲートペアを割らない）、位置は UTF-16 の添字で返す
// - 共通の頭と尻を先に落としてから Myers を回す（ふつうの手直しはここでほぼ終わる）
// - 差分が大きすぎる（全文の貼り直し等）ときは、真ん中を丸ごと置き換えたものとして扱う。
//   その範囲の名前は「手が入った」になり、辞書どおりに倒れる（実名が出る側には倒れない）

/** 前の文の [aStart, aEnd) を、今の文の [bStart, bEnd) に置き換えた。挿入は aStart === aEnd、削除は bStart === bEnd。 */
export interface Edit {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Myers で調べる編集距離の上限（これを超えたら真ん中を丸ごと置き換えとみなす）。記憶は上限の二乗に比例する。 */
const MAX_D = 1500;

function codePoints(s: string): { cps: number[]; offs: number[] } {
  const cps: number[] = [];
  const offs: number[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    cps.push(cp);
    offs.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  offs.push(s.length);
  return { cps, offs };
}

/** 一致した並び [前の文の添字, 今の文の添字, 長さ]（真ん中の中の添字）。上限を超えたら null。 */
function myersRuns(a: number[], ao: number, n: number, b: number[], bo: number, m: number): [number, number, number][] | null {
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const limit = Math.min(max, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[ao + x] === b[bo + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    // trace[d][k + d] = d 手目を終えたときの対角線 k の到達点
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;

  const runs: [number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const get = (k: number): number => prev[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = get(pk);
    const py = px - pk;
    const sx = down ? px : px + 1;
    const sy = sx - k;
    if (x > sx) runs.push([sx, sy, x - sx]);
    x = px;
    y = py;
  }
  if (x > 0) runs.push([0, 0, x]);
  runs.reverse();
  return runs;
}

/** a → b の編集の列（前から順・重ならない）。 */
export function diffEdits(a: string, b: string): Edit[] {
  if (a === b) return [];
  const A = codePoints(a);
  const B = codePoints(b);
  const n0 = A.cps.length;
  const m0 = B.cps.length;
  let pre = 0;
  while (pre < n0 && pre < m0 && A.cps[pre] === B.cps[pre]) pre++;
  let suf = 0;
  while (suf < n0 - pre && suf < m0 - pre && A.cps[n0 - 1 - suf] === B.cps[m0 - 1 - suf]) suf++;
  const n = n0 - pre - suf;
  const m = m0 - pre - suf;

  const cpEdits: [number, number, number, number][] = [];
  const runs = myersRuns(A.cps, pre, n, B.cps, pre, m);
  if (runs === null) {
    cpEdits.push([0, n, 0, m]);
  } else {
    let x = 0;
    let y = 0;
    for (const [rx, ry, len] of runs) {
      if (rx > x || ry > y) cpEdits.push([x, rx, y, ry]);
      x = rx + len;
      y = ry + len;
    }
    if (x < n || y < m) cpEdits.push([x, n, y, m]);
  }
  return cpEdits.map(([as, ae, bs, be]) => ({
    aStart: A.offs[pre + as]!,
    aEnd: A.offs[pre + ae]!,
    bStart: B.offs[pre + bs]!,
    bEnd: B.offs[pre + be]!,
  }));
}

/**
 * 前の文の [start, end) の**内側**に手が入ったか。
 * 範囲に掛かる削除・置換、範囲の内側への挿入は「手が入った」。境目（start・end ちょうど）への挿入は数えない。
 */
export function touched(edits: Edit[], start: number, end: number): boolean {
  for (const e of edits) {
    if (e.aStart === e.aEnd) {
      if (start < e.aStart && e.aStart < end) return true;
    } else if (e.aStart < end && e.aEnd > start) {
      return true;
    }
  }
  return false;
}

/** 範囲の始まり p の写し先（p が編集の内側なら、その編集の始まりへ寄せる）。 */
export function mapStart(edits: Edit[], p: number): number {
  for (const e of edits) if (e.aStart < p && p < e.aEnd) return e.bStart;
  return mapPos(edits, p);
}

/** 範囲の終わり p の写し先（p が編集の内側なら、その編集の終わりへ寄せる。p ちょうどへの挿入は含めない）。 */
export function mapEnd(edits: Edit[], p: number): number {
  let delta = 0;
  for (const e of edits) {
    if (e.aStart < p && p < e.aEnd) return e.bEnd;
    if (e.aEnd < p || (e.aEnd === p && e.aStart < e.aEnd)) delta += e.bEnd - e.bStart - (e.aEnd - e.aStart);
  }
  return p + delta;
}

/** 前の文の位置 p が今の文のどこか（p ちょうどへの挿入は p の前に入ったものとみなす）。 */
export function mapPos(edits: Edit[], p: number): number {
  let delta = 0;
  for (const e of edits) {
    if (e.aEnd <= p) delta += e.bEnd - e.bStart - (e.aEnd - e.aStart);
  }
  return p + delta;
}
