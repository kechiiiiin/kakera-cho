// 既にページがある言葉の確認（かけら言葉リンク設計 §3.5）のテスト。
import { describe, expect, it } from 'vitest';
import { candidateContext } from '../card/pick';
import { stripWikilinks, wordCandidates, wordsOf, wrapWordCandidates } from '../markdown';
import type { Kakera } from './types';
import { applyWordLinks, planWordLinks, wordLinkEdits } from './word-links';

const k = (id: string, body: string): Kakera => ({ id, body, written_at: '2026-11-03T08:00:00+09:00', katachi_id: null, updated_at: '' });
const words = (body: string, pages: string[]) => wordCandidates(body, pages).map((c) => c.word);

describe('wordCandidates', () => {
  it('言葉ごとに最初の1か所だけ。本文の中の順', () => {
    const body = '読書のあと猫。読書と猫';
    expect(wordCandidates(body, ['猫', '読書'])).toEqual([
      { word: '読書', start: 0, end: 2 },
      { word: '猫', start: 5, end: 6 },
    ]);
  });
  it('そのかけらで既に囲んである言葉は出さない（他の場所に素で出ていても）', () => {
    expect(words('[[猫]]と猫と犬', ['猫', '犬'])).toEqual(['犬']);
    expect(words('[[**猫**]]と猫', ['猫'])).toEqual([]);
  });
  it('既存の括弧の中・URL・リンク記法・画像・コードの中は候補にしない', () => {
    const none = [
      '[[黒猫]]',
      '[[ 猫のいる家 ]]',
      'https://example.com/猫',
      'https://example.com/a猫',
      'www.example.com/猫',
      '<https://example.com/猫>',
      '<mailto:猫>',
      '[猫](https://example.com)',
      '[あ](/猫)',
      '[猫の話]: /a',
      '![猫](/api/photo/a.jpg)',
      '`猫`',
      '``あ`猫`い``',
      '```\n猫\n```',
      '~~~\n猫\n~~~',
      '\\[[猫]]',
    ];
    for (const body of none) expect(words(body, ['猫'])).toEqual([]);
  });
  it('除外の次にある本文の言葉は候補になる', () => {
    const body = '`猫` https://example.com/猫 [猫](https://example.com) 猫';
    const [c] = wordCandidates(body, ['猫']);
    expect(c!.start).toBe(body.lastIndexOf('猫'));
  });
  it('書式・見出し・リストの中は候補になり、読む画面でも言葉になる', () => {
    for (const body of ['**猫**', '~~猫~~', '## 猫', '- 猫', '> 猫']) {
      const cands = wordCandidates(body, ['猫']);
      expect(cands.length).toBe(1);
      expect(wordsOf(wrapWordCandidates(body, cands))).toEqual(['猫']);
    }
  });
  it('重なりは長い方を取る（始まりが先でも、2回目の長い語の中でも）', () => {
    expect(words('カフェオレ', ['カフェ', 'カフェオレ'])).toEqual(['カフェオレ']);
    expect(wordCandidates('あいうえ', ['あい', 'いうえ'])).toEqual([{ word: 'いうえ', start: 1, end: 4 }]);
    expect(words('カフェオレとカフェオレ', ['カフェ', 'カフェオレ'])).toEqual(['カフェオレ']);
    expect(wordCandidates('カフェオレとカフェ', ['カフェ', 'カフェオレ']).map((c) => c.start)).toEqual([0, 6]);
    // 長い語が囲み済みでも、短い語がその別の出現の中に入らない
    expect(words('[[カフェオレ]]とカフェオレ', ['カフェ', 'カフェオレ'])).toEqual([]);
  });
  it('囲むとリンクや画像に化ける場所は次の出現に回す', () => {
    expect(words('猫(https://example.com)', ['猫'])).toEqual([]);
    const body = '猫(https://example.com) と猫';
    expect(wordCandidates(body, ['猫'])[0]!.start).toBe(body.lastIndexOf('猫'));
    expect(words('!猫(/a.jpg)', ['猫'])).toEqual([]);
  });
  it('索引に空の言葉があっても、本文が空でも止まらない', () => {
    expect(words('猫', ['', ' '])).toEqual([]);
    expect(words('', ['猫'])).toEqual([]);
  });
  it('囲むと読む画面の言葉になり、括弧を外すと元の本文に完全に戻る', () => {
    const bodies = [
      '朝のあと、筋トレ。猫に邪魔された\n\n![](/api/photo/a.jpg)\n\nhttps://example.com/猫',
      '**猫**と`猫`、[猫](https://example.com)と筋トレ\n  前後に空白  ',
      '🐈猫🐈筋トレ',
    ];
    for (const body of bodies) {
      const cands = wordCandidates(body, ['猫', '筋トレ']);
      const out = wrapWordCandidates(body, cands);
      expect(out).not.toBe(body);
      expect(wordsOf(out).sort()).toEqual(cands.map((c) => c.word).sort());
      expect(stripWikilinks(out)).toBe(body);
    }
  });
});

describe('確認の行と本文の直し', () => {
  const list = [k('A', '朝[[マック]]のあと、筋トレ。猫'), k('B', 'カフェで読書'), k('C', '寝る')];
  const pages = ['猫', '読書', 'カフェ', '筋トレ', 'マック'];

  it('行はかけらの順・本文の中の順', () => {
    expect(planWordLinks(list, pages).map((r) => [r.kakera_id, r.word])).toEqual([
      ['A', '筋トレ'],
      ['A', '猫'],
      ['B', 'カフェ'],
      ['B', '読書'],
    ]);
    expect(planWordLinks([list[2]!], pages)).toEqual([]);
  });
  it('選んだぶんだけ囲む。全部外せば直しは無い', () => {
    const rows = planWordLinks(list, pages);
    expect(wordLinkEdits(rows)).toEqual([
      { id: 'A', body: '朝[[マック]]のあと、[[筋トレ]]。[[猫]]' },
      { id: 'B', body: '[[カフェ]]で[[読書]]' },
    ]);
    expect(wordLinkEdits(rows.filter((r) => r.word === '猫'))).toEqual([{ id: 'A', body: '朝[[マック]]のあと、筋トレ。[[猫]]' }]);
    expect(wordLinkEdits([])).toEqual([]);
  });
  it('順番に直す（前が終わるまで次を始めない）。失敗したらそこで止まって投げる', async () => {
    const log: string[] = [];
    const patch = async (id: string) => {
      log.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 1));
      if (id === 'B') throw new Error('だめ');
      log.push(`end ${id}`);
    };
    const edits = ['A', 'B', 'C'].map((id) => ({ id, body: 'x' }));
    await expect(applyWordLinks(edits, patch)).rejects.toThrow('だめ');
    expect(log).toEqual(['start A', 'end A', 'start B']);
  });
});

describe('candidateContext', () => {
  it('前後の文を添える。括弧・書式の記号・写真は出さない', () => {
    const body = '朝[[マック]]のあと、**筋トレ**。\n![](/api/photo/a.jpg)\n猫に邪魔された';
    const [c] = wordCandidates(body, ['筋トレ']);
    expect(candidateContext(body, c!)).toEqual({ before: '朝マックのあと、', word: '筋トレ', after: '。 猫に邪魔された' });
  });
  it('言葉のすぐ横の空白を残し、長い本文は言葉のまわりだけにする', () => {
    const [c] = wordCandidates('あ 猫 い', ['猫']);
    expect(candidateContext('あ 猫 い', c!)).toEqual({ before: 'あ ', word: '猫', after: ' い' });
    const long = 'あ'.repeat(100) + '猫' + 'い'.repeat(100);
    const out = candidateContext(long, wordCandidates(long, ['猫'])[0]!);
    expect(out.before).toBe('…' + 'あ'.repeat(30));
    expect(out.after).toBe('い'.repeat(60) + '…');
  });
});
