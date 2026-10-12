// PATCH /api/kakera/:id の入力の検査（かけら時刻の指定と修正設計・2026-10-12）。

import { describe, expect, it } from 'vitest';
import { ApiError } from '../http';
import { FUTURE_TOLERANCE_MS, toJstIso } from '../time';
import { parseKakeraPatch } from './patch';

const NOW = new Date('2026-10-12T18:15:30+09:00').getTime();

function rejects(input: Record<string, unknown>): ApiError {
  try {
    parseKakeraPatch(input, NOW);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    return e as ApiError;
  }
  throw new Error('拒否されませんでした');
}

describe('parseKakeraPatch', () => {
  it('本文だけ・日時だけ・両方のどれでも受け取る', () => {
    expect(parseKakeraPatch({ body: ' 本文 ' }, NOW)).toEqual({ body: '本文' });
    expect(parseKakeraPatch({ written_at: '2026-10-11T09:05:00+09:00' }, NOW)).toEqual({
      written_at: '2026-10-11T09:05:00+09:00',
    });
    expect(parseKakeraPatch({ body: 'x', written_at: '2026-10-11T09:05+09:00' }, NOW)).toEqual({
      body: 'x',
      written_at: '2026-10-11T09:05:00+09:00',
    });
  });

  it('空: どちらも無い・本文が空白だけ・本文が文字列でない は拒否', () => {
    expect(rejects({}).message).toContain('written_at');
    expect(rejects({ body: '   ' }).message).toBe('本文が空です');
    expect(rejects({ body: 1 }).message).toBe('本文が空です');
    expect(rejects({ body: '', written_at: '2026-10-11T09:05:00+09:00' }).message).toBe('本文が空です');
  });

  it('形式: オフセットの無いもの・日付だけ・文字列でないもの は拒否', () => {
    rejects({ written_at: '2026-10-11T09:05:00' });
    rejects({ written_at: '2026-10-11' });
    rejects({ written_at: '2026-10-11 09:05:00+09:00' });
    rejects({ written_at: 1760000000 });
    rejects({ written_at: null });
    rejects({ written_at: '2026-13-45T25:61:00+09:00' });
  });

  it('秒は 00 にそろえ、他のオフセットは +09:00 に直す', () => {
    expect(parseKakeraPatch({ written_at: '2026-10-11T09:05:59+09:00' }, NOW).written_at).toBe('2026-10-11T09:05:00+09:00');
    // UTC 23:30 は JST の翌日 08:30
    expect(parseKakeraPatch({ written_at: '2026-10-10T23:30:45+00:00' }, NOW).written_at).toBe('2026-10-11T08:30:00+09:00');
  });

  it('未来: 数分のずれは許し、それを超えたら拒否', () => {
    expect(parseKakeraPatch({ written_at: '2026-10-12T18:18:00+09:00' }, NOW).written_at).toBe('2026-10-12T18:18:00+09:00');
    const beyond = new Date(NOW + FUTURE_TOLERANCE_MS + 60_000);
    expect(rejects({ written_at: toJstIso(beyond) }).message).toContain('未来');
    expect(rejects({ written_at: '2026-10-13T09:00:00+09:00' }).message).toContain('未来');
  });
});
