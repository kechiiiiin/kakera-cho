// 移動の軌跡（migrations/0014）: 入力の検査・まとめて入れる・id 重複は飛ばす・その日の点を時刻順。
// D1 はローカルの miniflare（一時フォルダ）。schema.sql → 0001〜0014 を番号順に当てる（本番と同じ形）。
// 擬似の点は公共の場所（駅・公園）の近く。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ApiError } from '../http';
import { ulid } from '../ulid';
import { insertKakera, listKakeraOn } from './db';
import { insertPlace, listPlacesOn } from './day-db';
import { TRACK_BATCH_MAX, insertTrackPoints, listTrackOn, parseTrackPost } from './track';

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

const ok = { id: ID, at: '2026-11-28T09:00:00+09:00', lat: 33.583, lng: 130.36, accuracy: 120, source: 'slc' };

describe('POST /api/track の検査', () => {
  it('形のよい点を通す。accuracy は無くてよい。at は +09:00 にそろえる', () => {
    expect(parseTrackPost({ points: [ok] }, NOW)).toEqual([ok]);
    const [p] = parseTrackPost({ points: [{ ...ok, accuracy: undefined, at: '2026-11-28T00:00:00+00:00', source: 'visit' }] }, NOW);
    expect(p).toMatchObject({ accuracy: null, at: '2026-11-28T09:00:00+09:00', source: 'visit' });
  });

  it('空・上限超え・壊れた点は 400', () => {
    expect(status400(() => parseTrackPost({ points: [] }, NOW))).toMatch(/空/);
    expect(status400(() => parseTrackPost({}, NOW))).toMatch(/points/);
    const many = Array.from({ length: TRACK_BATCH_MAX + 1 }, () => ({ ...ok, id: ulid(NOW) }));
    expect(status400(() => parseTrackPost({ points: many }, NOW))).toMatch(String(TRACK_BATCH_MAX));
    expect(parseTrackPost({ points: many.slice(0, TRACK_BATCH_MAX) }, NOW)).toHaveLength(TRACK_BATCH_MAX);
    status400(() => parseTrackPost({ points: [{ ...ok, id: 'x' }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, at: '2026-11-28T09:00:00' }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, at: '2026-11-28T13:00:00+09:00' }] }, NOW)); // 未来
    status400(() => parseTrackPost({ points: [{ ...ok, lat: 91 }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, lng: -181 }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, lat: null }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, accuracy: -1 }] }, NOW));
    status400(() => parseTrackPost({ points: [{ ...ok, source: 'manual' }] }, NOW));
    expect(status400(() => parseTrackPost({ points: [ok, { ...ok, lat: 'a' }] }, NOW))).toMatch(/^points\.1\.lat/);
  });
});

const root = join(__dirname, '../../..');
const MIGRATIONS = [
  '0001_fts_trigram_search', '0002_link_card', '0003_name_map', '0004_katachi_kakera', '0005_katachi_written_order',
  '0006_photo_choice', '0007_nikki_description', '0008_publish_body', '0009_name_doc', '0010_drop_position_choice',
  '0011_photo_face', '0012_show_time', '0013_day_place',
  '0014_track',
  '0014_track', // 再適用しても壊れない（IF NOT EXISTS）
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-track-'));
  const files = ['schema.sql', ...MIGRATIONS.map((m) => `migrations/${m}.sql`)];
  writeFileSync(join(dir, 'all.sql'), files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n'));
  execFileSync(
    join(root, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'kakera', '--local', '--persist-to', join(dir, 'state'), '--file', join(dir, 'all.sql')],
    { cwd: root, stdio: 'pipe' }
  );
  proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: join(dir, 'state', 'v3') } });
  db = proxy.env.DB;
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function pt(at: string, lat: number, lng: number, source: 'slc' | 'visit' = 'slc') {
  return { id: ulid(Date.parse(at)), at, lat, lng, accuracy: 100, source };
}

describe('軌跡の D1', () => {
  it('まとめて入る。同じ id は送り直しでも同じ送りの中でも黙って飛ばす', async () => {
    const a = pt('2026-11-20T08:00:00+09:00', 33.58, 130.36);
    const b = pt('2026-11-20T08:30:00+09:00', 33.59, 130.38, 'visit');
    expect(await insertTrackPoints(db, [a, b, a])).toEqual({ added: 2, skipped: 1 });
    expect(await insertTrackPoints(db, [a, b])).toEqual({ added: 0, skipped: 2 });
    const c = pt('2026-11-20T09:00:00+09:00', 33.59, 130.4);
    expect(await insertTrackPoints(db, [b, c])).toEqual({ added: 1, skipped: 1 });
    expect((await listTrackOn(db, '2026-11-20')).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });

  it('その日（JST の 0:00〜23:59）の点だけを時刻順。送った順ではない', async () => {
    const late = pt('2026-11-21T23:59:59+09:00', 33.6, 130.4);
    const first = pt('2026-11-21T00:00:00+09:00', 33.5, 130.3);
    const before = pt('2026-11-20T23:59:59+09:00', 33.5, 130.3);
    const after = pt('2026-11-22T00:00:00+09:00', 33.5, 130.3);
    await insertTrackPoints(db, [late, after, first, before]);
    const got = await listTrackOn(db, '2026-11-21');
    expect(got.map((p) => p.at)).toEqual(['2026-11-21T00:00:00+09:00', '2026-11-21T23:59:59+09:00']);
    expect(got[0]).toMatchObject({ lat: 33.5, lng: 130.3, accuracy: 100, source: 'slc' });
    expect(got[0]!.created_at).toMatch(/\+09:00$/);
    expect(await listTrackOn(db, '2026-11-23')).toEqual([]);
  });

  it('既存の表（かけら・場所）には触らない', async () => {
    await insertKakera(db, { id: ulid(), body: '軌跡の日のかけら', written_at: '2026-11-24T12:00:00+09:00' });
    await insertPlace(db, { id: ulid(), at: '2026-11-24T12:00:00+09:00', name: '駅', lat: 33.59, lng: 130.4, source: 'visit' });
    await insertTrackPoints(db, [pt('2026-11-24T12:00:00+09:00', 33.59, 130.4, 'visit')]);
    expect((await listKakeraOn(db, '2026-11-24')).map((k) => k.body)).toEqual(['軌跡の日のかけら']);
    expect((await listPlacesOn(db, '2026-11-24')).map((p) => p.name)).toEqual(['駅']);
  });

  it('D1 の CHECK でも source と座標の範囲は守られる', async () => {
    await expect(
      db.prepare("INSERT INTO track_point (id, at, lat, lng, source, created_at) VALUES ('x', 'a', 0, 0, 'manual', 'c')").run()
    ).rejects.toThrow();
    await expect(
      db.prepare("INSERT INTO track_point (id, at, lat, lng, source, created_at) VALUES ('y', 'a', 99, 0, 'slc', 'c')").run()
    ).rejects.toThrow();
  });
});
