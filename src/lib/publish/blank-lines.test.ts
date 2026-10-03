// 空行の保持（U+00A0 の行）の規則。仮名だけで書く（このリポジトリは public）。
import { describe, expect, it } from 'vitest';
import { NBSP, composePublishBody, markBlankLinesForBlog } from './blank-lines';

const mark = (s: string): string => markBlankLinesForBlog(s);
const gap = `\n\n${NBSP}\n\n`;

describe('markBlankLinesForBlog', () => {
  it('段落の間の空行は U+00A0 の行に', () => {
    expect(mark('あ\n\nい')).toBe(`あ${gap}い`);
    expect(mark('あ\n\n\nい')).toBe(`あ\n\n${NBSP}\n\n${NBSP}\n\nい`);
  });

  it('リストの中の空行は変えない（リストを割らない）', () => {
    expect(mark('- いち\n\n- に')).toBe('- いち\n\n- に');
    expect(mark('1. いち\n\n2. に\n\n\n3. さん')).toBe('1. いち\n\n2. に\n\n\n3. さん');
    expect(mark('* いち\n\n  つづき')).toBe('* いち\n\n  つづき');
    expect(mark('- いち\n  つづき\n\n- に')).toBe('- いち\n  つづき\n\n- に');
  });

  it('リストの前後の空行はこれまでどおり', () => {
    expect(mark('まえ\n\n- いち\n- に\n\nあと')).toBe(`まえ${gap}- いち\n- に${gap}あと`);
  });

  it('リストのあとの区切り線の前は変えない（区切り線の規則）', () => {
    expect(mark('- いち\n\n---\n\nあと')).toBe('- いち\n\n---\n\nあと');
  });

  it('コードフェンスの中・字下げのコードは変えない', () => {
    expect(mark('```\na\n\nb\n```')).toBe('```\na\n\nb\n```');
    expect(mark('    a\n\n    b')).toBe('    a\n\n    b');
  });

  it('見出し・引用の前後の空行は U+00A0 の行に（隙間として見せる）', () => {
    expect(mark('## み\n\nほん')).toBe(`## み${gap}ほん`);
    expect(mark('> いんよう\n\nほん')).toBe(`> いんよう${gap}ほん`);
  });

  it('写真の前後は変えない', () => {
    expect(mark('あ\n\n![](/p/1.jpg)\n\nい')).toBe('あ\n\n![](/p/1.jpg)\n\nい');
  });

  it('composePublishBody はかけらを区切り線でつなぐ', () => {
    expect(composePublishBody(['- a\n\n- b', 'c\n\nd'])).toBe(`- a\n\n- b\n\n---\n\nc${gap}d`);
  });
});
