// 書き出しの本文に入る時刻の小見出し（かけら時刻表示設計・2026-10-12）。仮名だけで書く（このリポジトリは public）。
import { describe, expect, it } from 'vitest';
import { NBSP, composePublishBody } from './blank-lines';
import { timeHeadLine, withTimeHead } from './time-head';

const H1 = { label: '06:00', datetime: '2026-10-10T06:00:00+09:00' };
const H2 = { label: '10-11 03:20', datetime: '2026-10-11T03:20:00+09:00' };
const line = (h: { label: string; datetime: string }) =>
  `<p class="kakera-time"><time datetime="${h.datetime}">${h.label}</time></p>`;

describe('timeHeadLine', () => {
  it('クラス付きの段落と time 要素の1行（見出し記法にしない）', () => {
    expect(timeHeadLine(H2)).toBe('<p class="kakera-time"><time datetime="2026-10-11T03:20:00+09:00">10-11 03:20</time></p>');
    expect(timeHeadLine(H2)).not.toMatch(/^#/);
  });
  it('属性と中身はエスケープする', () => {
    expect(timeHeadLine({ label: '<a>', datetime: '"x"&' })).toBe('<p class="kakera-time"><time datetime="&quot;x&quot;&amp;">&lt;a&gt;</time></p>');
  });
});

describe('withTimeHead', () => {
  it('頭に足し、直後は本物の空行（HTML ブロックを閉じる）', () => {
    expect(withTimeHead('あ', H1)).toBe(`${line(H1)}\n\nあ`);
  });
  it('中身が空のかけらには足さない（時刻だけが残らない）', () => {
    expect(withTimeHead('', H1)).toBe('');
    expect(withTimeHead('  \n ', H1)).toBe('');
  });
  it('出さないなら本文のまま', () => {
    expect(withTimeHead('あ', null)).toBe('あ');
    expect(withTimeHead('あ', undefined)).toBe('あ');
  });
});

describe('composePublishBody と時刻', () => {
  const bodies = ['行橋、スタート。\n\n空気が冷たい。', '![](/api/photo/kakera/2026/10/a.jpg)\n\nゴール。', 'まんなか。'];

  it('チェックなし（timeHeads 無し・全部 null）なら今と同じ出力', () => {
    const before = composePublishBody(bodies);
    expect(composePublishBody(bodies, undefined, undefined)).toBe(before);
    expect(composePublishBody(bodies, undefined, [null, null, null])).toBe(before);
    expect(composePublishBody(bodies, undefined, [])).toBe(before);
  });

  it('チェックしたかけらの上にだけ小見出し。空行の U+00A0 化と区切り線はそのまま', () => {
    const out = composePublishBody(bodies, undefined, [H1, null, H2]);
    expect(out).toBe(
      [
        line(H1),
        '',
        '行橋、スタート。',
        '',
        NBSP,
        '',
        '空気が冷たい。',
        '',
        '---',
        '',
        '![](/api/photo/kakera/2026/10/a.jpg)',
        '',
        'ゴール。',
        '',
        '---',
        '',
        line(H2),
        '',
        'まんなか。',
      ].join('\n')
    );
  });

  it('写真から始まるかけらでも、小見出しの下に写真が来る（写真に接する空行は本物のまま）', () => {
    const out = composePublishBody([bodies[1]!], undefined, [H2]);
    expect(out).toBe(`${line(H2)}\n\n![](/api/photo/kakera/2026/10/a.jpg)\n\nゴール。`);
  });

  it('中身が空になったかけら（写真をすべて出さない）は、時刻ごと飛ばす', () => {
    const out = composePublishBody(['あ', '', 'い'], undefined, [null, H1, H2]);
    expect(out).toBe(`あ\n\n---\n\n${line(H2)}\n\nい`);
    expect(out).not.toContain(H1.datetime);
  });

  it('行として独立した URL（カード・埋め込み）は小見出しと別の段落のまま', () => {
    const url = 'https://example.com/a';
    const out = composePublishBody([`${url}\n\nあ`], (k) => k.includes('example.com'), [H1]);
    expect(out.split('\n')).toEqual([line(H1), '', url, '', 'あ']);
  });
});
