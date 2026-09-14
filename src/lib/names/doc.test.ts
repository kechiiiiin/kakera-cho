// 名前の記号方式の純関数のテスト（公開名変換設計・記号方式の移行とテスト §6）。
// ⚠️ 仮名の辞書だけで書く。家族の実名を書かない（このリポジトリは public）。
//
// 仮の辞書: 太郎→長男／花子→妻／次→次男（置き換え先が置き換え元を含む）／太郎々→太郎々（例外）

import { describe, expect, it } from 'vitest';
import {
  applyPublishEdit,
  copyShape,
  normalizePublishShape,
  parseSegments,
  realTextOf,
  resolveShape,
  sameAsOriginal,
  shapeFrom,
  syncRealShape,
  type ChoiceAction,
  type NameDocShape,
} from './doc';
import { assembleNikki, assemblePart } from './assemble';
import { diffEdits, mapPos, touched } from './diff';
import type { NameEntry } from './replace';
import { isPublishBodyStale } from '../publish/publish-body';

const DICT: NameEntry[] = [
  { id: 'd1', source: '太郎', target: '長男' },
  { id: 'd2', source: '花子', target: '妻' },
  { id: 'd3', source: '次', target: '次男' },
  { id: 'd4', source: '太郎々', target: '太郎々' },
];

let seq = 0;
const newId = (): string => `R${String(++seq).padStart(5, '0')}`;

const build = (text: string, dict = DICT): NameDocShape => syncRealShape(null, text, dict, newId).shape;
const out = (shape: NameDocShape, dict = DICT): string => resolveShape(shape, dict).text;
const refOf = (shape: NameDocShape, source: string, nth = 0) => shape.refs.filter((r) => r.source === source)[nth]!;
const choose = (shape: NameDocShape, id: string, action: ChoiceAction, text: string | null = null): NameDocShape => ({
  segments: shape.segments,
  refs: shape.refs.map((r) => (r.id === id ? { ...r, action, text: action === 'edit' ? text : null } : r)),
});
/** 日記用に直す: 欄を開いた文（置き換え済み）から d1 に書き換えて保存する */
const savePublish = (base: NameDocShape, d1: string | ((d0: string) => string), dict = DICT) => {
  const d0 = out(base, dict);
  const next = typeof d1 === 'function' ? d1(d0) : d1;
  return applyPublishEdit(base, dict, d0, next, newId);
};

describe('差分', () => {
  it('境目への挿入は手が入ったに数えず、内側は数える', () => {
    const e1 = diffEdits('太郎が', '太郎は');
    expect(touched(e1, 0, 2)).toBe(false);
    const e2 = diffEdits('太郎', '太X郎');
    expect(touched(e2, 0, 2)).toBe(true);
    const e3 = diffEdits('太郎', '、太郎');
    expect(touched(e3, 0, 2)).toBe(false);
    expect(mapPos(e3, 0)).toBe(1);
  });
});

describe('1. 原本「花子と太郎」', () => {
  it('記号 2・解くと「妻と長男」', () => {
    const s = build('花子と太郎');
    expect(s.refs).toHaveLength(2);
    expect(out(s)).toBe('妻と長男');
    // 記号の JSON に実名を入れない
    expect(JSON.stringify(s.segments)).not.toContain('花子');
    expect(JSON.stringify(s.segments)).not.toContain('太郎');
  });
});

describe('2. 例語の衝突「長男の太郎」', () => {
  const s = build('長男の太郎');
  it('先頭の「長男」は普通の文字、「太郎」だけ記号', () => {
    expect(s.segments[0]).toEqual({ t: '長男の' });
    expect(s.refs.map((r) => r.source)).toEqual(['太郎']);
    expect(out(s)).toBe('長男の長男');
  });
  it('欄で二つ目の「長男」を「兄」に → その記号は外れる', () => {
    const r = savePublish(copyShape(s, newId), '長男の兄');
    expect(r.shape.refs).toHaveLength(0);
    expect(out(r.shape)).toBe('長男の兄');
  });
  it('一つ目の「長男の」を消す → 出力は見えていたとおり', () => {
    const r = savePublish(copyShape(s, newId), '長男');
    // どちらの「長男」が消えたかは差分では区別できないが、出る文字は見えていたとおりで、実名は出ない
    expect(out(r.shape)).toBe('長男');
    expect(assemblePart({ seg: 'k', label: 'かけら 1', shape: r.shape, body: true }, DICT).text).toBe('長男');
    expect(realTextOf(r.shape).text.length).toBeGreaterThan(0);
  });
});

describe('3. 最長一致・例外', () => {
  it('「太郎々」は例外の記号 1 つ', () => {
    const s = build('太郎々');
    expect(s.refs).toHaveLength(1);
    expect(s.refs[0]!.source).toBe('太郎々');
    expect(out(s)).toBe('太郎々');
  });
  it('「太郎」の直後に「々」を足す → 例外に置き直し、前の選択は消える', () => {
    const s0 = build('太郎が来た');
    const s1 = choose(s0, refOf(s0, '太郎').id, 'reject');
    const r = syncRealShape(s1, '太郎々が来た', DICT, newId);
    expect(r.shape.refs.map((x) => x.source)).toEqual(['太郎々']);
    expect(r.shape.refs[0]!.id).not.toBe(s0.refs[0]!.id);
    expect(r.lost).toEqual([{ source: '太郎', action: 'reject', text: null, now: null }]);
    expect(out(r.shape)).toBe('太郎々が来た');
  });
});

describe('4. 名前の中の書き換え（実名の文）', () => {
  it('「太郎」→「太朗」で記号が消え、普通の文字', () => {
    const s0 = build('太郎が来た');
    const s1 = choose(s0, s0.refs[0]!.id, 'edit', '兄');
    const r = syncRealShape(s1, '太朗が来た', DICT, newId);
    expect(r.shape.refs).toHaveLength(0);
    expect(out(r.shape)).toBe('太朗が来た');
    expect(r.lost).toEqual([{ source: '太郎', action: 'edit', text: '兄', now: null }]);
  });
});

describe('5. 名前の周りの書き換え', () => {
  it('「太郎が」→「太郎は」・前に「、」を足す → 記号も拒否・手で直した言葉も残る', () => {
    const s0 = build('太郎が花子と');
    const s1 = choose(choose(s0, refOf(s0, '太郎').id, 'reject'), refOf(s0, '花子').id, 'edit', '姉');
    const r1 = syncRealShape(s1, '太郎は花子と', DICT, newId);
    const r2 = syncRealShape(r1.shape, '、太郎は花子と', DICT, newId);
    expect(r2.shape.refs.map((x) => [x.id, x.action, x.text])).toEqual([
      [s0.refs[0]!.id, 'reject', null],
      [s0.refs[1]!.id, 'edit', '姉'],
    ]);
    expect(r2.lost).toEqual([]);
    expect(out(r2.shape)).toBe('、太郎は姉と');
  });
});

describe('6. 欄で名前の言葉を書き換え', () => {
  const base = copyShape(build('太郎と遊ぶ'), newId);
  it('表示「長男」→「息子」: 普通の文字になり選択を捨てる', () => {
    const r = savePublish(choose(base, base.refs[0]!.id, 'edit', '長男'), '息子と遊ぶ');
    expect(r.shape.refs).toHaveLength(0);
    expect(out(r.shape)).toBe('息子と遊ぶ');
  });
  it('後ろに「くん」: 記号は残る', () => {
    const r = savePublish(base, '長男くんと遊ぶ');
    expect(r.shape.refs.map((x) => x.id)).toEqual([base.refs[0]!.id]);
    expect(out(r.shape)).toBe('長男くんと遊ぶ');
  });
});

describe('7. 欄に新しく「花子」と打つ', () => {
  it('保存後に記号（辞書どおり）', () => {
    const base = copyShape(build('太郎と遊ぶ'), newId);
    const r = savePublish(base, '長男と花子と遊ぶ');
    expect(r.shape.refs.map((x) => [x.source, x.action])).toEqual([
      ['太郎', 'approve'],
      ['花子', 'approve'],
    ]);
    expect(out(r.shape)).toBe('長男と妻と遊ぶ');
  });
});

describe('8. 拒否・手で直したまま欄を保存', () => {
  it('触らなかった箇所は拒否・手で直した言葉のまま。原本に戻すと原本側の選択が戻る', () => {
    const k0 = build('太郎と花子');
    const orig = choose(choose(k0, refOf(k0, '太郎').id, 'reject'), refOf(k0, '花子').id, 'edit', '姉');
    // 欄は置き換え済みの文で開く（拒否は実名）
    expect(out(orig)).toBe('太郎と姉');
    const r = savePublish(copyShape(orig, newId), (d0) => d0 + '。');
    expect(r.shape.refs.map((x) => [x.source, x.action, x.text])).toEqual([
      ['太郎', 'reject', null],
      ['花子', 'edit', '姉'],
    ]);
    expect(out(r.shape)).toBe('太郎と姉。');
    // 日記用の側で選び直しても、原本側は別
    const pub2 = choose(r.shape, r.shape.refs[0]!.id, 'approve');
    expect(out(pub2)).toBe('長男と姉。');
    // 原本に戻す＝原本の文書を使う
    expect(out(orig)).toBe('太郎と姉');
  });
  it('原本と同じ文・同じ選択に戻ったら書き換えを持たない', () => {
    const k0 = build('太郎と花子');
    const pub = copyShape(k0, newId);
    const r = savePublish(pub, (d0) => d0);
    expect(sameAsOriginal(r.shape, k0)).toBe(true);
  });
});

describe('9. 「次」を含む文で日記用に直すを開く→保存を 3 回', () => {
  it('「次男男」にならない', () => {
    let shape = copyShape(build('次の日に行く'), newId);
    for (let i = 0; i < 3; i++) {
      shape = savePublish(shape, (d0) => d0 + '！').shape;
      expect(out(shape)).not.toContain('次男男');
    }
    expect(out(shape)).toBe('次男の日に行く！！！');
    // 変えずに開いて閉じても変わらない
    expect(savePublish(shape, (d0) => d0).shape).toEqual(shape);
  });
});

describe('10. URL 中の名前', () => {
  it('URL の中は記号にならない。リンクの表示文字だけ記号', () => {
    expect(build('https://example.com/太郎 を見た').refs).toHaveLength(0);
    const link = build('[太郎](https://example.com/太郎)');
    expect(link.refs).toHaveLength(1);
    expect(out(link)).toBe('[長男](https://example.com/太郎)');
    expect(build('<https://example.com/太郎>').refs).toHaveLength(0);
    expect(build('[a]: https://example.com/太郎').refs).toHaveLength(0);
  });
});

describe('11. 代替文字', () => {
  const key = 'kakera/2026/09/a.jpg';
  const text = `今日。\n\n![太郎の写真](/api/photo/${key})`;
  it('代替文字は記号。出さない写真の中の記号は数えず、拒否していても念押しに出ない', () => {
    const s0 = build(text);
    expect(s0.refs).toHaveLength(1);
    const s1 = choose(s0, s0.refs[0]!.id, 'reject');
    const shown = assemblePart({ seg: 'k', label: 'かけら 1', shape: s1, expected: text, body: true }, DICT);
    expect(shown.spans.filter((x) => x.status === 'reject')).toHaveLength(1);
    const a = assembleNikki(
      {
        title: { seg: 'title', label: 'タイトル', shape: build(''), expected: '', body: false },
        description: null,
        bodies: [{ seg: 'k', label: 'かけら 1', shape: s1, expected: text, body: true, hidden: new Set([key]) }],
      },
      DICT
    );
    expect(a.bodies[0]!.text).toBe('今日。');
    expect(a.rejects).toHaveLength(0);
  });
});

describe('12. 欄で表示「長男」の直前に URL を貼る', () => {
  it('記号は残り「長男」が出る（実名が出ない）', () => {
    const base = copyShape(build('太郎と遊ぶ'), newId);
    const r = savePublish(base, 'https://example.com/長男と遊ぶ');
    expect(r.shape.refs.map((x) => x.id)).toEqual([base.refs[0]!.id]);
    const a = assemblePart({ seg: 'k', label: 'かけら 1', shape: r.shape, body: true }, DICT);
    expect(a.text).toBe('https://example.com/長男と遊ぶ');
    expect(a.text).not.toContain('太郎');
  });
});

describe('13. 原本の編集: 段落を足す・消す・入れ替える・全文を貼り直す', () => {
  const p1 = '太郎が来た。';
  const p2 = '花子も来た。';
  const s0 = build(`${p1}\n\n${p2}`);
  const s1 = choose(choose(s0, refOf(s0, '太郎').id, 'reject'), refOf(s0, '花子').id, 'edit', '姉');
  const actions = (s: NameDocShape) => Object.fromEntries(s.refs.map((r) => [r.source, [r.action, r.text]]));
  it('段落を足す', () => {
    const r = syncRealShape(s1, `前書き。\n\n${p1}\n\n${p2}`, DICT, newId);
    expect(actions(r.shape)).toEqual({ 太郎: ['reject', null], 花子: ['edit', '姉'] });
  });
  it('段落を消す', () => {
    const r = syncRealShape(s1, p2, DICT, newId);
    expect(actions(r.shape)).toEqual({ 花子: ['edit', '姉'] });
    expect(r.lost).toEqual([]);
  });
  it('入れ替える（行ごと動いた名前の選択は残る）', () => {
    const r = syncRealShape(s1, `${p2}\n\n${p1}`, DICT, newId);
    expect(actions(r.shape)).toEqual({ 太郎: ['reject', null], 花子: ['edit', '姉'] });
    expect(r.lost).toEqual([]);
    expect(out(r.shape)).toBe('姉も来た。\n\n太郎が来た。');
  });
  it('全文を貼り直す（同じ文）', () => {
    const r = syncRealShape(s1, `${p1}\n\n${p2}`, DICT, newId);
    expect(r.changed).toBe(false);
    expect(actions(r.shape)).toEqual({ 太郎: ['reject', null], 花子: ['edit', '姉'] });
  });
});

describe('14. 辞書の変更', () => {
  it('置き換え先を変える → 保存済みの書き換えにも効く', () => {
    const pub = savePublish(copyShape(build('太郎と遊ぶ'), newId), (d0) => d0 + '。').shape;
    const dict2 = DICT.map((d) => (d.source === '太郎' ? { ...d, target: '息子' } : d));
    expect(out(pub, dict2)).toBe('息子と遊ぶ。');
  });
  it('語を足す → 次に開くと記号', () => {
    const noHanako = DICT.filter((d) => d.source !== '花子');
    const s0 = build('太郎と花子', noHanako);
    expect(s0.refs).toHaveLength(1);
    const r = syncRealShape(s0, '太郎と花子', DICT, newId);
    expect(r.shape.refs.map((x) => x.source)).toEqual(['太郎', '花子']);
    // 日記用の文でも
    const pub = copyShape(s0, newId);
    expect(normalizePublishShape(pub, DICT, newId).shape.refs).toHaveLength(2);
  });
  it('語を消す → 辞書どおりは実名に戻り、手で直した言葉は残る、拒否は実名のまま（§12 の 20）', () => {
    const s0 = build('太郎と太郎と太郎');
    const [a, b, c] = s0.refs;
    const s1 = choose(choose(s0, a!.id, 'edit', '兄'), c!.id, 'reject');
    const noTaro = DICT.filter((d) => d.source !== '太郎');
    const real = syncRealShape(s1, '太郎と太郎と太郎', noTaro, newId);
    expect(out(real.shape, noTaro)).toBe('兄と太郎と太郎');
    expect(real.lost).toEqual([]);
    const pub = normalizePublishShape(copyShape(s1, newId), noTaro, newId);
    expect(out(pub.shape, noTaro)).toBe('兄と太郎と太郎');
    expect(b).toBeDefined();
  });
  it('例外を足す → 短い語の選択が消える', () => {
    const noExc = DICT.filter((d) => d.source !== '太郎々');
    const s0 = build('太郎々だ', noExc);
    const s1 = choose(s0, s0.refs[0]!.id, 'edit', '兄');
    expect(out(s1, noExc)).toBe('兄々だ');
    const r = syncRealShape(s1, '太郎々だ', DICT, newId);
    expect(r.shape.refs.map((x) => x.source)).toEqual(['太郎々']);
    expect(r.lost).toEqual([{ source: '太郎', action: 'edit', text: '兄', now: null }]);
    const p = normalizePublishShape(copyShape(s1, newId), DICT, newId);
    expect(p.shape.refs.map((x) => x.source)).toEqual(['太郎々']);
    expect(p.lost).toHaveLength(1);
  });
});

describe('15. 解けない（fail-closed）', () => {
  const text = '太郎と花子';
  const good = build(text);
  const part = (shape: NameDocShape | null) => ({ seg: 'k', label: 'かけら 1', shape, expected: text, body: true });
  it('segments を壊す', () => {
    expect(parseSegments('{"v":1,"s":[{"x":1}]}')).toBeNull();
    expect(parseSegments('{')).toBeNull();
    expect(() => assemblePart(part(null), DICT)).toThrow(/記号/);
  });
  it('記号の行を消す', () => {
    expect(shapeFrom(good.segments, good.refs.slice(1))).toBeNull();
    expect(() => assemblePart(part({ segments: good.segments, refs: good.refs.slice(1) }), DICT)).toThrow(/記号/);
  });
  it('他の文書の記号を入れる', () => {
    const other = build('花子');
    const mixed = [...good.segments, ...other.segments];
    expect(shapeFrom(mixed, good.refs)).toBeNull();
  });
  it('同じ記号を二度', () => {
    const dup = [...good.segments, good.segments.find((s) => 'r' in s)!];
    expect(shapeFrom(dup, good.refs)).toBeNull();
    expect(() => assemblePart(part({ segments: dup, refs: good.refs }), DICT)).toThrow(/記号/);
  });
  it('approve の置き換え元が辞書に無い・実名で解いても元の文と合わない', () => {
    const noTaro = DICT.filter((d) => d.source !== '太郎');
    expect(() => assemblePart(part(good), noTaro)).toThrow(/解けません/);
    expect(() => assemblePart({ ...part(good), expected: '太郎と花子。' }, DICT)).toThrow(/合いません/);
  });
});

describe('16. 取り残し', () => {
  it('置き換えてよい文脈の t に「太郎」がある → 止まる', () => {
    const shape: NameDocShape = { segments: [{ t: '太郎が来た' }], refs: [] };
    expect(() => assemblePart({ seg: 'k', label: 'かけら 1', shape, body: true }, DICT)).toThrow(/記号になっていない名前/);
    // 拒否（記号の出力の中）は通す・置き換え先が置き換え元を含む辞書も通す
    const s = build('太郎と次');
    const ok = assemblePart({ seg: 'k', label: 'かけら 1', shape: choose(s, s.refs[0]!.id, 'reject'), body: true }, DICT);
    expect(ok.text).toBe('太郎と次男');
  });
});

describe('17. 写真: 手で直した言葉に `]` を入れる', () => {
  const key = 'kakera/2026/09/b.jpg';
  it('公開する Markdown では打ち消されて記法が崩れず、出さない写真はきちんと除かれる（§12 の 21）', () => {
    const text = `![太郎](/api/photo/${key}) と [太郎](https://example.com/)`;
    const s0 = build(text);
    const s1 = choose(choose(s0, s0.refs[0]!.id, 'edit', 'a]b'), s0.refs[1]!.id, 'edit', 'x](y');
    const a = assemblePart({ seg: 'k', label: 'かけら 1', shape: s1, expected: text, body: true, hidden: new Set([key]) }, DICT);
    expect(a.text).toBe('と [x\\]\\(y](https://example.com/)');
    expect(a.text).not.toContain(key);
  });
  it('それでも key が残ったら止まる', () => {
    const shape: NameDocShape = { segments: [{ t: `![壊れ(/api/photo/${key})` }], refs: [] };
    expect(() =>
      assemblePart({ seg: 'k', label: 'かけら 1', shape, body: true, hidden: new Set([key]) }, DICT)
    ).toThrow(/出さない写真が残って/);
  });
});

describe('18. 原本が変わっています', () => {
  it('書き換えを使う → 書き換え側の記号・選択はそのまま。原本に戻す → 原本側の選択', () => {
    const orig = build('太郎と遊ぶ');
    const origChosen = choose(orig, orig.refs[0]!.id, 'reject');
    const pub = savePublish(copyShape(origChosen, newId), (d0) => d0 + '。').shape;
    const pubChosen = choose(pub, pub.refs[0]!.id, 'edit', '兄');
    expect(isPublishBodyStale('2026-09-14T10:00:00+09:00', '2026-09-14T09:00:00+09:00')).toBe(true);
    // 使う: basis を進めるだけ（形は変えない）
    expect(isPublishBodyStale('2026-09-14T10:00:00+09:00', '2026-09-14T10:00:00+09:00')).toBe(false);
    expect(out(pubChosen)).toBe('兄と遊ぶ。');
    // 原本に戻す: 原本の文書（原本が直されていれば今の文に合わせたもの）
    const synced = syncRealShape(origChosen, '太郎と遊んだ', DICT, newId).shape;
    expect(out(synced)).toBe('太郎と遊んだ');
  });
});

describe('19. rev（純関数の側）', () => {
  it('欄を開いた後に選択が変わったら、開いたときの文と合わず止まる', () => {
    const base = copyShape(build('太郎と遊ぶ'), newId);
    const d0 = out(base);
    const changed = choose(base, base.refs[0]!.id, 'reject');
    expect(() => applyPublishEdit(changed, DICT, d0, d0 + '。', newId)).toThrow();
  });
});

describe('20. タイトル', () => {
  it('題を少し変えても手の入っていない名前の選択は残る', () => {
    const s0 = build('太郎と花子の休日');
    const s1 = choose(s0, refOf(s0, '花子').id, 'reject');
    const r = syncRealShape(s1, '太郎と花子のすてきな休日', DICT, newId);
    expect(refOf(r.shape, '花子').action).toBe('reject');
    expect(out(r.shape)).toBe('長男と花子のすてきな休日');
  });
});

describe('21. サロゲートペア', () => {
  it('絵文字の直前・直後の名前、名前の間に絵文字を挟む → 範囲が文字を割らない', () => {
    const s0 = build('🎉太郎🎉花子🎉');
    expect(s0.refs).toHaveLength(2);
    expect(out(s0)).toBe('🎉長男🎉妻🎉');
    const s1 = choose(s0, refOf(s0, '太郎').id, 'reject');
    const r = syncRealShape(s1, '🎉太郎🌸🎉花子🎉', DICT, newId);
    expect(refOf(r.shape, '太郎').action).toBe('reject');
    for (const seg of r.shape.segments) {
      if ('t' in seg) expect(seg.t).toBe(Array.from(seg.t).join(''));
    }
    const d = diffEdits('a🎉b', 'a🌸b');
    expect(d).toEqual([{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 3 }]);
    const pub = savePublish(copyShape(s1, newId), (d0) => d0.replace('🎉妻', '🎈妻'));
    expect(out(pub.shape)).toBe('🎉太郎🎈妻🎉');
    expect(pub.shape.refs.map((x) => x.action)).toEqual(['reject', 'approve']);
  });
});

describe('22. 全操作の前後で入力（原本）を書き換えない', () => {
  it('純関数は渡した形・文を変えない', () => {
    const text = '太郎と花子と次';
    const s0 = build(text);
    const snapshot = JSON.stringify(s0);
    syncRealShape(s0, text + '。', DICT, newId);
    savePublish(copyShape(s0, newId), (d0) => d0 + '！');
    normalizePublishShape(s0, DICT, newId);
    assemblePart({ seg: 'k', label: 'かけら 1', shape: s0, expected: text, body: true }, DICT);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});
