// かけらごとに出す時刻の規則（かけら時刻表示設計 §2・2026-10-12）。
import { describe, expect, it } from 'vitest';
import { kakeraTimeLabel, timeHeadOf } from './time-label';

describe('kakeraTimeLabel（かたちの日付と違う日だけ日付を添える）', () => {
  it('同じ日は HH:MM', () => {
    expect(kakeraTimeLabel('2026-10-10T06:00:00+09:00', '2026-10-10')).toBe('06:00');
    expect(kakeraTimeLabel('2026-10-10T23:59:00+09:00', '2026-10-10')).toBe('23:59');
  });
  it('翌日（日付をまたいだ）は MM-DD HH:MM', () => {
    expect(kakeraTimeLabel('2026-10-11T03:20:00+09:00', '2026-10-10')).toBe('10-11 03:20');
    expect(kakeraTimeLabel('2026-10-11T00:00:00+09:00', '2026-10-10')).toBe('10-11 00:00');
  });
  it('前の日でも日付を添える', () => {
    expect(kakeraTimeLabel('2026-10-09T22:15:00+09:00', '2026-10-10')).toBe('10-09 22:15');
  });
  it('年が違うときは年から添える（MM-DD だけでは別の年と読めないため）', () => {
    expect(kakeraTimeLabel('2026-12-31T23:30:00+09:00', '2027-01-01')).toBe('2026-12-31 23:30');
  });
  it('文字列をそのまま切る（端末の時差に左右されない）', () => {
    expect(kakeraTimeLabel('2026-10-11T00:30:00+09:00', '2026-10-11')).toBe('00:30');
  });
});

describe('timeHeadOf（チェックしたかけらだけ）', () => {
  it('チェックなし・未指定は null', () => {
    expect(timeHeadOf({ written_at: '2026-10-10T06:00:00+09:00', show_time: false }, '2026-10-10')).toBeNull();
    expect(timeHeadOf({ written_at: '2026-10-10T06:00:00+09:00' }, '2026-10-10')).toBeNull();
  });
  it('チェックありは文字と written_at', () => {
    expect(timeHeadOf({ written_at: '2026-10-11T03:20:00+09:00', show_time: true }, '2026-10-10')).toEqual({
      label: '10-11 03:20',
      datetime: '2026-10-11T03:20:00+09:00',
    });
  });
});
