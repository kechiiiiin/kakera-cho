// 1日のページの入力の決まり（かけら帳1日のページ設計・段階1）: 日付・気分の値・場所の検査・外した印。
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http';
import {
  MOODS,
  isCalendarDate,
  parseDateParam,
  parseDayPut,
  parseHiddenCreate,
  parseHiddenKey,
  parsePlaceCreate,
  parsePlacePatch,
} from './day-input';

const NOW = Date.parse('2026-11-28T12:00:00+09:00');
const ID = '01JD0000000000000000000000';

function status400(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    return (e as ApiError).message;
  }
  throw new Error('400 になりませんでした');
}

describe('日付', () => {
  it('YYYY-MM-DD で暦にある日だけ通す', () => {
    expect(isCalendarDate('2026-11-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(parseDateParam('2026-11-28')).toBe('2026-11-28');
    status400(() => parseDateParam(undefined));
    status400(() => parseDateParam('2026-11-31'));
  });
});

describe('気分', () => {
  it('嬉・楽・穏・疲・哀 と null（外す）だけ', () => {
    expect([...MOODS]).toEqual(['嬉', '楽', '穏', '疲', '哀']);
    for (const m of MOODS) expect(parseDayPut({ mood: m })).toEqual({ mood: m });
    expect(parseDayPut({ mood: null })).toEqual({ mood: null });
    expect(status400(() => parseDayPut({ mood: '怒' }))).toMatch(/^mood: /);
    status400(() => parseDayPut({}));
    status400(() => parseDayPut({ mood: '' }));
    status400(() => parseDayPut({ mood: 1 }));
  });
});

describe('場所を足す', () => {
  it('時刻は +09:00 に揃え、名前は前後の空白を落とす。source の既定は manual', () => {
    expect(parsePlaceCreate({ id: ID, at: '2026-11-28T01:30:00+00:00', name: '  公園 ', lat: 35.6, lng: 139.7 }, NOW)).toEqual({
      id: ID,
      at: '2026-11-28T10:30:00+09:00',
      name: '公園',
      lat: 35.6,
      lng: 139.7,
      source: 'manual',
    });
  });

  it('座標は無くてよい（両方 null）。片方だけは 400', () => {
    expect(parsePlaceCreate({ id: ID, at: '2026-11-28T10:30+09:00', name: '駅', source: 'visit' }, NOW)).toMatchObject({
      lat: null,
      lng: null,
      source: 'visit',
    });
    expect(parsePlaceCreate({ id: ID, at: '2026-11-28T10:30+09:00', name: '駅', lat: null, lng: null }, NOW).lat).toBeNull();
    status400(() => parsePlaceCreate({ id: ID, at: '2026-11-28T10:30+09:00', name: '駅', lat: 35 }, NOW));
  });

  it('id・時刻・名前・座標・source の形が違えば 400', () => {
    const ok = { id: ID, at: '2026-11-28T10:30:00+09:00', name: '駅' };
    status400(() => parsePlaceCreate({ ...ok, id: 'x' }, NOW));
    status400(() => parsePlaceCreate({ ...ok, at: '2026-11-28T10:30:00' }, NOW)); // オフセット無し
    status400(() => parsePlaceCreate({ ...ok, at: '2026-11-28T13:00:00+09:00' }, NOW)); // 未来（5分を超える）
    expect(parsePlaceCreate({ ...ok, at: '2026-11-28T12:04:00+09:00' }, NOW).at).toBe('2026-11-28T12:04:00+09:00'); // 数分のずれは許す
    status400(() => parsePlaceCreate({ ...ok, name: '   ' }, NOW));
    status400(() => parsePlaceCreate({ ...ok, name: 'あ'.repeat(201) }, NOW));
    status400(() => parsePlaceCreate({ ...ok, lat: 91, lng: 0 }, NOW));
    status400(() => parsePlaceCreate({ ...ok, lat: 0, lng: -181 }, NOW));
    status400(() => parsePlaceCreate({ ...ok, lat: '35', lng: '139' }, NOW));
    status400(() => parsePlaceCreate({ ...ok, source: 'gps' }, NOW));
  });
});

describe('場所を直す', () => {
  it('送ったものだけ。座標は組で、null で外す', () => {
    expect(parsePlacePatch({ name: ' 港 ' }, NOW)).toEqual({ name: '港' });
    expect(parsePlacePatch({ at: '2026-11-27T08:00:00+09:00' }, NOW)).toEqual({ at: '2026-11-27T08:00:00+09:00' });
    expect(parsePlacePatch({ lat: 1, lng: 2 }, NOW)).toEqual({ lat: 1, lng: 2 });
    expect(parsePlacePatch({ lat: null, lng: null }, NOW)).toEqual({ lat: null, lng: null });
    status400(() => parsePlacePatch({}, NOW));
    status400(() => parsePlacePatch({ lat: 1 }, NOW));
    status400(() => parsePlacePatch({ lat: 1, lng: null }, NOW));
    status400(() => parsePlacePatch({ name: '' }, NOW));
  });
});

describe('一覧から外す印', () => {
  it('kind は event・photo だけ。ref は空にしない', () => {
    expect(parseHiddenCreate({ kind: 'photo', ref: 'ABC/L0/001', date: '2026-11-28' })).toEqual({
      kind: 'photo',
      ref: 'ABC/L0/001',
      date: '2026-11-28',
    });
    expect(parseHiddenKey({ kind: 'event', ref: 'e1' })).toEqual({ kind: 'event', ref: 'e1' });
    status400(() => parseHiddenCreate({ kind: 'kakera', ref: 'x', date: '2026-11-28' }));
    status400(() => parseHiddenCreate({ kind: 'event', ref: '', date: '2026-11-28' }));
    status400(() => parseHiddenCreate({ kind: 'event', ref: 'x', date: '2026-11-32' }));
    status400(() => parseHiddenKey({ kind: 'event', ref: null }));
  });
});
