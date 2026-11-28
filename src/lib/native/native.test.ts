// iPhone 版に渡す計算の口（/api/native/*）の中身のテスト（かけら帳ネイティブ化設計）。
// Web 版の画面が手元で組むものと同じ結果になることを、同じ関数を直に呼んだ結果と突き合わせて確かめる。
// ⚠️ 仮名の辞書だけで書く（このリポジトリは public）。仮の辞書: 太郎→長男／花子→妻／太郎々→太郎々（例外）

import { describe, expect, it } from 'vitest';
import { textForPick, candidateContext } from '../card/pick';
import { planWordLinks } from '../kakera/word-links';
import { buildRealShape, resolveShape, type NameDocShape } from '../names/doc';
import type { DocView } from '../names/doc-db';
import type { NameEntry } from '../names/replace';
import { renderDiaryFile } from '../publish/diary-file';
import { composePublishBody } from '../publish/blank-lines';
import { convertView, type ConvertKakera } from './convert-view';
import { nameTry, pickTexts, wordPlan } from './text-tools';

const DICT: NameEntry[] = [
  { id: 'd1', source: '太郎', target: '長男' },
  { id: 'd2', source: '花子', target: '妻' },
  { id: 'd4', source: '太郎々', target: '太郎々' },
];

let seq = 0;
const newId = (): string => `R${String(++seq).padStart(5, '0')}`;

function doc(seg: string, kind: DocView['kind'], text: string, patch: (s: NameDocShape) => NameDocShape = (s) => s): DocView {
  const shape = patch(buildRealShape(text, DICT, newId));
  return {
    seg,
    kind,
    doc_id: `doc-${seg}-${kind}`,
    rev: 'rev1',
    segments: shape.segments,
    refs: shape.refs,
    lost_choices: [],
    basis: null,
    stale: false,
    updated_at: '',
  };
}

const K1: ConvertKakera = { id: 'K1', body: '朝、太郎と公園。\n\n![](/api/photo/kakera/2026/11/28_0800_K1_1.jpg)', written_at: '2026-11-28T08:00:00+09:00' };
const K2: ConvertKakera = { id: 'K2', body: '夜は[[花子]]と太郎々の話', written_at: '2026-11-29T21:30:00+09:00', show_time: true };

function baseInput() {
  return {
    katachi_date: '2026-11-28',
    kakera: [K1, K2],
    order: ['K1', 'K2'],
    title: '太郎の日',
    description: '',
    entries: DICT,
    docs: [doc('title', 'title', '太郎の日'), doc('K1', 'kakera', K1.body), doc('K2', 'kakera', K2.body)],
    photos: [] as { kakera_id: string; key: string }[],
    cards: {},
  };
}

describe('pickTexts', () => {
  it('textForPick と同じ（本文ごと）', () => {
    const bodies = ['[[京都]]で[[奈良]]', '[[a]](https://example.com/x)', '写真\n![](/api/photo/kakera/a.jpg)\nhttps://www.example.com/a/b?q=1'];
    expect(pickTexts(bodies)).toEqual(bodies.map((b) => textForPick(b)));
  });
});

describe('wordPlan', () => {
  it('planWordLinks と candidateContext を合わせたものと同じ', () => {
    const kakera = [
      { id: 'A', body: '朝マックのあと、筋トレ。 猫に邪魔された' },
      { id: 'B', body: '[[猫]]と猫と犬' },
    ];
    const pages = ['筋トレ', '猫', '犬'];
    const want = planWordLinks(
      kakera.map((k) => ({ ...k, written_at: '', katachi_id: null, updated_at: '' })),
      pages
    ).map((r) => {
      const c = candidateContext(r.body, r);
      return { key: r.key, kakera_id: r.kakera_id, word: r.word, start: r.start, end: r.end, before: c.before, after: c.after };
    });
    expect(wordPlan(kakera, pages)).toEqual(want);
    expect(want.map((r) => r.key)).toEqual(['A:筋トレ', 'A:猫', 'B:犬']);
  });
});

describe('nameTry', () => {
  it('記号にしてから辞書どおりに解く（例外は置き換えない）', () => {
    const r = nameTry('太郎と花子と太郎々', DICT);
    expect(r.text).toBe('長男と妻と太郎々');
    expect(r.spans.map((s) => [s.source, s.status, s.word])).toEqual([
      ['太郎', 'dict', '長男'],
      ['花子', 'dict', '妻'],
      ['太郎々', 'exception', '太郎々'],
    ]);
    const shape = buildRealShape('花子', DICT, () => 'x');
    expect(r.text.slice(r.spans[1]!.start, r.spans[1]!.end)).toBe(resolveShape(shape, DICT).text);
  });
});

describe('convertView', () => {
  it('辞書どおりの姿・集計・Markdown（書き出しと同じ組み方）', () => {
    const v = convertView(baseInput());
    expect(v.segs.map((s) => s.seg)).toEqual(['title', 'K1', 'K2']);
    expect(v.segs[0]!.text).toBe('長男の日');
    expect(v.segs[1]!.text).toBe('朝、長男と公園。\n\n![](/api/photo/kakera/2026/11/28_0800_K1_1.jpg)');
    // 言葉の括弧は見せる文から外し、括弧つきは raw_text に残す
    expect(v.segs[2]!.text).toBe('夜は妻と太郎々の話');
    expect(v.segs[2]!.raw_text).toBe('夜は[[妻]]と太郎々の話');
    expect(v.counts).toEqual({ dict: 3, edit: 0, reject: 0, exc: 1 });
    expect(v.photo_count).toEqual({ shown: 1, hidden: 0 });
    expect(v.want_faces).toEqual(['kakera/2026/11/28_0800_K1_1.jpg']);
    expect(v.assemble_error).toBeNull();
    expect(v.cannot_export).toBe(false);
    expect(v.segs[2]!.time_head).toEqual({ label: '11-29 21:30', datetime: K2.written_at });
    expect(v.segs[1]!.time).toBe('08:00');
    const bodies = v.assembled!.bodies.map((b) => b.text);
    expect(v.markdown).toBe(
      renderDiaryFile('長男の日', '2026-11-28', composePublishBody(bodies, () => false, [null, { label: '11-29 21:30', datetime: K2.written_at }]), '')
    );
    // 画像の切れには写真の key を添える
    const img = v.segs[1]!.tokens.find((t) => t.kind === 'image');
    expect(img && img.kind === 'image' ? img.photo_key : null).toBe('kakera/2026/11/28_0800_K1_1.jpg');
    // 書き出しに送る選択と版
    expect(v.choices.every((c) => c.action === 'approve')).toBe(true);
    expect(v.doc_revs.map((d) => d.doc_id)).toEqual(['doc-title-title', 'doc-K1-kakera', 'doc-K2-kakera']);
  });

  it('写真を出さない・拒否を選ぶと、集計と書き出す中身が変わる', () => {
    const input = baseInput();
    input.photos = [{ kakera_id: 'K1', key: 'kakera/2026/11/28_0800_K1_1.jpg' }];
    input.docs[1] = doc('K1', 'kakera', K1.body, (s) => ({
      ...s,
      refs: s.refs.map((r) => (r.source === '太郎' ? { ...r, action: 'reject' as const } : r)),
    }));
    const v = convertView(input);
    expect(v.photo_count).toEqual({ shown: 0, hidden: 1 });
    expect(v.want_faces).toEqual([]);
    expect(v.counts.reject).toBe(1);
    expect(v.rejects).toEqual([{ seg: 'K1', id: input.docs[1]!.refs[0]!.id }]);
    expect(v.markdown).not.toContain('/api/photo/');
    expect(v.markdown).toContain('朝、太郎と公園。');
    expect(v.choices.find((c) => c.ref_id === input.docs[1]!.refs[0]!.id)?.action).toBe('reject');
  });

  it('写真だけのかけらで写真を出さないと、その段は空・全部空なら書き出せない印', () => {
    const only: ConvertKakera = { id: 'P', body: '![](/api/photo/kakera/2026/11/28_0900_P_1.jpg)', written_at: '2026-11-28T09:00:00+09:00' };
    const v = convertView({
      ...baseInput(),
      kakera: [only],
      order: ['P'],
      docs: [doc('title', 'title', '太郎の日'), doc('P', 'kakera', only.body)],
      photos: [{ kakera_id: 'P', key: 'kakera/2026/11/28_0900_P_1.jpg' }],
    });
    expect(v.segs[1]!.empty).toBe(true);
    expect(v.composed_empty).toBe(true);
  });

  it('文書が無い段は error・書き出せない', () => {
    const input = baseInput();
    input.docs = input.docs.filter((d) => d.seg !== 'K2');
    const v = convertView(input);
    expect(v.segs[2]!.error).toBe('名前の記号がまだありません。開き直してください。');
    expect(v.cannot_export).toBe(true);
  });

  it('説明があれば段を作る・辞書が空なら印', () => {
    const v = convertView({ ...baseInput(), description: '花子と散歩', docs: [...baseInput().docs, doc('description', 'description', '花子と散歩')] });
    expect(v.segs.map((s) => s.seg)).toEqual(['title', 'description', 'K1', 'K2']);
    expect(v.assembled!.description).toBe('妻と散歩');
    expect(convertView({ ...baseInput(), entries: [] }).dict_empty).toBe(true);
  });
});
