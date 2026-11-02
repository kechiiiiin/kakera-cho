// 言葉のリンク（かけら言葉リンク設計 §2.1・§3）の読み方のテスト。
import { describe, expect, it } from 'vitest';
import { buildExcerpt, hasVisibleWikilink, parseInline, stripWikilinks, textForExcerpt, wordsOf } from './markdown';
import { textForPick } from './card/pick';

describe('stripWikilinks', () => {
  it('通常・同じ行に複数', () => {
    expect(stripWikilinks('[[京都]]へ')).toBe('京都へ');
    expect(stripWikilinks('[[京都]]と[[奈良]]、[[京都]]')).toBe('京都と奈良、京都');
    expect(stripWikilinks('一行目[[あ]]\n二行目[[い]]')).toBe('一行目あ\n二行目い');
  });
  it('コードの中は残す', () => {
    expect(stripWikilinks('`[[x]]` と [[y]]')).toBe('`[[x]]` と y');
    expect(stripWikilinks('``a ` [[x]]`` [[y]]')).toBe('``a ` [[x]]`` y');
    expect(stripWikilinks('```\n[[x]]\n```\n[[y]]')).toBe('```\n[[x]]\n```\ny');
    expect(stripWikilinks('~~~\n[[x]]\n~~~\n[[y]]')).toBe('~~~\n[[x]]\n~~~\ny');
    expect(stripWikilinks('```\n[[x]]')).toBe('```\n[[x]]'); // 閉じないフェンスは終わりまで
  });
  it('[[a]](url)。安全な URL はリンク、安全でない URL は言葉', () => {
    expect(stripWikilinks('[[a]](https://example.com)')).toBe('[[a]](https://example.com)');
    expect(stripWikilinks('[[a]](javascript:alert)')).toBe('a(javascript:alert)');
    expect(stripWikilinks('[[a]](/relative)')).toBe('a(/relative)');
  });
  it('閉じない [[ はそのまま', () => {
    expect(stripWikilinks('[[京都')).toBe('[[京都');
    expect(stripWikilinks('[[京都]')).toBe('[[京都]');
    expect(stripWikilinks('[[あ\nい]]')).toBe('[[あ\nい]]');
  });
  it('書式の記号はそのまま（公開でも太字が残る）', () => {
    expect(stripWikilinks('**[[x]]**')).toBe('**x**');
    expect(stripWikilinks('[[**あ**い]]')).toBe('**あ**い');
  });
  it('公開で括弧が見えるものは、読む画面で言葉でなくても外す', () => {
    expect(stripWikilinks('\\[[x]]')).toBe('x');
    expect(stripWikilinks('[[ ]]と[[]]')).toBe(' と');
    // 読む画面のコードの読み方（空行をまたぐ）と違い、公開側では空行をまたぐとコードにならない
    expect(stripWikilinks('`あ\n\n[[x]]\n\nい`')).toBe('`あ\n\nx\n\nい`');
    // title の形でないものは公開側でリンクにならない
    expect(stripWikilinks('[[a]](https://example.com b)')).toBe('a(https://example.com b)');
    expect(stripWikilinks('[[[x]]](https://example.com)')).toBe('[x](https://example.com)');
    expect(stripWikilinks('![[[x]]](/api/photo/a.jpg)')).toBe('![x](/api/photo/a.jpg)');
    // 名前の置き換えが打ち消した括弧を含む言葉
    expect(stripWikilinks('[[仮\\]名]]')).toBe('仮\\]名');
  });
  it('リンク先・裸の URL は壊さない。画像の [x] は言葉ではない', () => {
    expect(stripWikilinks('https://example.com/[[a]]')).toBe('https://example.com/[[a]]');
    expect(stripWikilinks('![[x]](/api/photo/a.jpg)')).toBe('![[x]](/api/photo/a.jpg)');
  });
  it('plain（タイトル・説明）はコードもリンクも解釈せず全部外す', () => {
    expect(stripWikilinks('`[[x]]` [[a]](https://example.com)', { plain: true })).toBe('`x` a(https://example.com)');
  });
});

describe('hasVisibleWikilink', () => {
  it('外した後に括弧が見えるものを見つける', () => {
    expect(hasVisibleWikilink('京都')).toBe(false);
    expect(hasVisibleWikilink('`[[x]]`')).toBe(false);
    expect(hasVisibleWikilink('[[a]](https://example.com)')).toBe(false);
    expect(hasVisibleWikilink('[[閉じない')).toBe(false);
    expect(hasVisibleWikilink('[\\[x]]')).toBe(true);
    expect(hasVisibleWikilink('\\[\\[x\\]\\]')).toBe(true);
    expect(hasVisibleWikilink(stripWikilinks('[[[[x]]]]'))).toBe(true);
    expect(hasVisibleWikilink('[[x]]', { plain: true })).toBe(true);
  });
});

describe('wordsOf', () => {
  it('重複なし・出てきた順・前後の空白を落とす', () => {
    expect(wordsOf('[[京都]]と[[ 奈良 ]]、[[京都]]')).toEqual(['京都', '奈良']);
  });
  it('書式の記号を言葉に含めない', () => {
    expect(wordsOf('[[**あ**い]] [[~~う~~え]]')).toEqual(['あい', 'うえ']);
  });
  it('書式・見出し・リストの中の言葉も拾う', () => {
    expect(wordsOf('**[[a]]** *[[b]]* ~~[[c]]~~\n## [[d]]\n- [[e]]\n> [[f]]')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  it('コードの中・空白だけ・リンク・閉じない・改行入りは言葉にしない', () => {
    expect(wordsOf('`[[x]]`')).toEqual([]);
    expect(wordsOf('```\n[[x]]\n```')).toEqual([]);
    expect(wordsOf('~~~\n[[x]]\n~~~')).toEqual([]);
    expect(wordsOf('~~~\na~~b\n[[x]]\n~~c\n~~~')).toEqual([]);
    expect(wordsOf('[[ ]] [[]] [[****]]')).toEqual([]);
    expect(wordsOf('[[a]](https://example.com)')).toEqual([]);
    expect(wordsOf('[[a')).toEqual([]);
    expect(wordsOf('[[あ\nい]]')).toEqual([]);
    expect(wordsOf('[[a`b`c]]')).toEqual([]);
  });
  it('安全でない URL の [[a]](url) は言葉になる', () => {
    expect(wordsOf('[[a]](javascript:alert)')).toEqual(['a']);
  });
  it('かけら帳の読み方: \\[[x]] は素の文字、![[x]](url) は画像の記法のまま（k-editor の飾りとは違う）', () => {
    expect(wordsOf('\\[[x]]')).toEqual([]);
    expect(parseInline('\\[[x]]')).toEqual([{ type: 'text', value: '[[x]]' }]);
    expect(wordsOf('![[x]](https://example.com/a.jpg)')).toEqual([]);
  });
});

describe('parseInline の言葉', () => {
  it('前後の文字と分かれ、見た目の書式は children に残る', () => {
    expect(parseInline('あ[[**い**う]]え')).toEqual([
      { type: 'text', value: 'あ' },
      {
        type: 'wikilink',
        word: 'いう',
        children: [{ type: 'strong', children: [{ type: 'text', value: 'い' }] }, { type: 'text', value: 'う' }],
      },
      { type: 'text', value: 'え' },
    ]);
  });
  it('言葉の中に a を作らない。リンクの表示文字の言葉は文字になる', () => {
    const [node] = parseInline('[[https://example.com]]');
    expect(node).toEqual({ type: 'wikilink', word: 'https://example.com', children: [{ type: 'text', value: 'https://example.com' }] });
    expect(parseInline('[[[x]]](https://example.com)')).toEqual([
      { type: 'link', href: 'https://example.com', children: [{ type: 'text', value: 'x' }] },
    ]);
  });
  it('今までの読み方は変わらない', () => {
    expect(parseInline('[a](https://example.com) [b](javascript:x)')).toEqual([
      { type: 'link', href: 'https://example.com', children: [{ type: 'text', value: 'a' }] },
      { type: 'text', value: ' ' },
      { type: 'text', value: '[b](javascript:x)' },
    ]);
  });
});

describe('抜粋に括弧を出さない', () => {
  it('textForExcerpt・buildExcerpt（検索結果）', () => {
    expect(textForExcerpt('[[京都]]へ\n![](/api/photo/a.jpg)行った')).toBe('京都へ 行った');
    expect(buildExcerpt('今日は[[京都]]の朝', '京都')).toBe('今日は京都の朝');
  });
  it('textForPick（かたちにする・日記にするの選ぶ所）', () => {
    expect(textForPick('[[京都]]で[[奈良]]')).toBe('京都で奈良');
    expect(textForPick('[[a]](https://example.com/x)')).toBe('[a]');
  });
});
