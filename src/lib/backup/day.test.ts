// 控え（kakera-data）の1日のファイル: 気分と場所を丸ごと書き直す・無くなったら消す。GitHub は差し替える。
import { describe, expect, it } from 'vitest';
import type { Day, Place } from '../kakera/day-db';
import type { RepoRef } from './github';
import { backupDay, dayPath, renderDayFile, type DayFileIo } from './day';

const REF: RepoRef = { owner: 'o', repo: 'r', token: 't' };
const DAY: Day = { date: '2026-11-28', mood: '穏', updated_at: '2026-11-28T10:00:00+09:00' };
const PLACE: Place = {
  id: '01JD0000000000000000000000',
  at: '2026-11-28T09:05:00+09:00',
  name: '駅 "東口"',
  lat: 35.5,
  lng: 139.25,
  source: 'manual',
  created_at: '2026-11-28T09:06:00+09:00',
  updated_at: '2026-11-28T09:06:00+09:00',
};

function fakeIo() {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const io: DayFileIo = {
    putText: async (_ref, path, text) => {
      calls.push('put ' + path);
      written[path] = text;
    },
    deleteFile: async (_ref, path) => {
      calls.push('delete ' + path);
    },
  };
  return { io, calls, written };
}

describe('1日の控え', () => {
  it('気分と場所を frontmatter に、時刻と名前を本文に', () => {
    expect(dayPath('2026-11-28')).toBe('day/2026-11-28.md');
    const text = renderDayFile(DAY, [PLACE, { ...PLACE, id: '01JD0000000000000000000001', lat: null, lng: null, name: '家' }])!;
    expect(text).toContain('date: 2026-11-28\nmood: "穏"\nplaces:\n  - id: 01JD0000000000000000000000\n');
    expect(text).toContain('    name: "駅 \\"東口\\""\n    lat: 35.5\n    lng: 139.25\n    source: manual');
    expect(text).toContain('- 09:05 家');
    // 座標の無い場所は lat / lng を書かない
    expect(text.split('  - id: ')[2]).not.toContain('lat:');
  });

  it('気分だけの日も書く。どちらも無ければ消す', async () => {
    expect(renderDayFile(DAY, [])).toBe('---\ndate: 2026-11-28\nmood: "穏"\n---\n');
    const a = fakeIo();
    await backupDay(REF, DAY, [], a.io);
    expect(a.calls).toEqual(['put day/2026-11-28.md']);
    const b = fakeIo();
    await backupDay(REF, { ...DAY, mood: null }, [], b.io);
    expect(b.calls).toEqual(['delete day/2026-11-28.md']);
  });
});
