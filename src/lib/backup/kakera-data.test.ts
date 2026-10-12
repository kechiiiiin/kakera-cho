// 控え（kakera-data）のかけらの移動順（かけら時刻の指定と修正設計・2026-10-12）。
// GitHub への読み書きは差し替えて、順番だけを確かめる。

import { describe, expect, it } from 'vitest';
import type { Kakera } from '../kakera/types';
import type { RepoRef } from './github';
import { kakeraPath, relocateKakera, type KakeraFileIo } from './kakera-data';

const REF: RepoRef = { owner: 'o', repo: 'r', token: 't' };
const ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const BEFORE: Kakera = { id: ID, body: '本文', written_at: '2026-10-12T18:15:23+09:00', katachi_id: null, updated_at: '2026-10-12T18:15:23+09:00' };
const AFTER: Kakera = { ...BEFORE, written_at: '2026-09-30T07:05:00+09:00', updated_at: '2026-10-12T19:00:00+09:00' };

function fakeIo(opts: { failPut?: boolean } = {}) {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const io: KakeraFileIo = {
    putText: async (_ref, path, text) => {
      calls.push('put ' + path);
      if (opts.failPut) throw new Error('put に失敗');
      written[path] = text;
    },
    deleteFile: async (_ref, path) => {
      calls.push('delete ' + path);
    },
  };
  return { io, calls, written };
}

describe('relocateKakera', () => {
  it('パスは written_at から決まる', () => {
    expect(kakeraPath(BEFORE)).toBe(`kakera/2026/10/12_1815_${ID}.md`);
    expect(kakeraPath(AFTER)).toBe(`kakera/2026/09/30_0705_${ID}.md`);
  });

  it('日時が変わったら、新しいパスで書いてから旧パスを消す', async () => {
    const { io, calls, written } = fakeIo();
    await relocateKakera(REF, BEFORE, AFTER, io);
    expect(calls).toEqual([`put kakera/2026/09/30_0705_${ID}.md`, `delete kakera/2026/10/12_1815_${ID}.md`]);
    expect(written[kakeraPath(AFTER)]).toContain('written_at: 2026-09-30T07:05:00+09:00');
  });

  it('書くのに失敗したら旧パスは消さない（本文がどこにも無い瞬間を作らない）', async () => {
    const { io, calls } = fakeIo({ failPut: true });
    await expect(relocateKakera(REF, BEFORE, AFTER, io)).rejects.toThrow('put に失敗');
    expect(calls).toEqual([`put kakera/2026/09/30_0705_${ID}.md`]);
  });

  it('パスが変わらない（本文だけ・同じ分の中）なら書くだけで消さない', async () => {
    const { io, calls } = fakeIo();
    await relocateKakera(REF, BEFORE, { ...BEFORE, body: '直した', written_at: '2026-10-12T18:15:00+09:00' }, io);
    expect(calls).toEqual([`put kakera/2026/10/12_1815_${ID}.md`]);
  });
});
