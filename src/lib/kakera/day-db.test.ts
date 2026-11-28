// 1日のページの D1（migrations/0013）: その日の JST の範囲・気分の付け外し・場所の読み書き・外した印。
// D1 はローカルの miniflare（一時フォルダ）。schema.sql → 0001〜0013 を番号順に当てる（本番と同じ形）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ApiError } from '../http';
import { ulid } from '../ulid';
import { insertKakera, listKakeraOn } from './db';
import {
  addHidden,
  deletePlace,
  getDay,
  insertPlace,
  listHiddenOn,
  listPlacesOn,
  putDayMood,
  removeHidden,
  updatePlace,
} from './day-db';

const root = join(__dirname, '../../..');
const MIGRATIONS = [
  '0001_fts_trigram_search',
  '0002_link_card',
  '0003_name_map',
  '0004_katachi_kakera',
  '0005_katachi_written_order',
  '0006_photo_choice',
  '0007_nikki_description',
  '0008_publish_body',
  '0009_name_doc',
  '0010_drop_position_choice',
  '0011_photo_face',
  '0012_show_time',
  '0013_day_place',
  '0013_day_place', // 再適用しても壊れない（IF NOT EXISTS）
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-day-place-'));
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

function place(at: string, name: string, coords: [number, number] | null = null) {
  return { id: ulid(), at, name, lat: coords?.[0] ?? null, lng: coords?.[1] ?? null, source: 'manual' as const };
}

describe('気分', () => {
  it('押していない日は null。付けて・付け替えて・外せる。日ごとに別', async () => {
    expect(await getDay(db, '2026-11-20')).toEqual({ date: '2026-11-20', mood: null, updated_at: null });
    await putDayMood(db, '2026-11-20', '嬉');
    await putDayMood(db, '2026-11-21', '疲');
    expect((await getDay(db, '2026-11-20')).mood).toBe('嬉');
    await putDayMood(db, '2026-11-20', '穏');
    expect((await getDay(db, '2026-11-20')).mood).toBe('穏');
    const off = await putDayMood(db, '2026-11-20', null);
    expect(off.mood).toBeNull();
    const got = await getDay(db, '2026-11-20');
    expect(got.mood).toBeNull();
    expect(got.updated_at).toMatch(/\+09:00$/);
    expect((await getDay(db, '2026-11-21')).mood).toBe('疲');
  });

  it('決まった5つ以外は D1 の CHECK でも入らない', async () => {
    await expect(
      db.prepare("INSERT INTO day (date, mood, updated_at) VALUES ('2026-11-22', '怒', 'x')").run()
    ).rejects.toThrow();
  });
});

describe('場所', () => {
  it('JST の 0:00〜23:59 だけ・時刻順。かけらの日と同じ境目', async () => {
    const before = place('2026-11-22T23:59:00+09:00', '前の日');
    const late = place('2026-11-23T23:59:59+09:00', '夜', [35.68, 139.76]);
    const first = place('2026-11-23T00:00:00+09:00', '朝');
    const after = place('2026-11-24T00:00:00+09:00', '次の日');
    for (const p of [before, late, first, after]) await insertPlace(db, p);
    await insertKakera(db, { id: ulid(), body: 'その日のかけら', written_at: '2026-11-23T12:00:00+09:00' });

    const got = await listPlacesOn(db, '2026-11-23');
    expect(got.map((p) => p.name)).toEqual(['朝', '夜']);
    expect(got[1]).toMatchObject({ lat: 35.68, lng: 139.76, source: 'manual' });
    expect(got[0]).toMatchObject({ lat: null, lng: null });
    // 既存のかけらは変わらず引ける（新しい表を足しただけ）
    expect((await listKakeraOn(db, '2026-11-23')).map((k) => k.body)).toEqual(['その日のかけら']);
  });

  it('同じ id は 409。直すと送ったものだけ変わり、座標は組で外せる。消すと無くなる', async () => {
    const p = place('2026-11-25T09:00:00+09:00', '駅', [35, 139]);
    await insertPlace(db, p);
    await expect(insertPlace(db, p)).rejects.toMatchObject({ status: 409 });

    const { place: moved, before } = await updatePlace(db, p.id, { at: '2026-11-26T10:00:00+09:00', name: '港' });
    expect(before.at).toBe('2026-11-25T09:00:00+09:00');
    expect(moved).toMatchObject({ at: '2026-11-26T10:00:00+09:00', name: '港', lat: 35, lng: 139 });
    expect(await listPlacesOn(db, '2026-11-25')).toEqual([]);

    const { place: noCoords } = await updatePlace(db, p.id, { lat: null, lng: null });
    expect(noCoords).toMatchObject({ lat: null, lng: null, name: '港' });
    expect((await listPlacesOn(db, '2026-11-26'))[0]).toMatchObject({ lat: null, lng: null });

    await deletePlace(db, p.id);
    expect(await listPlacesOn(db, '2026-11-26')).toEqual([]);
    await expect(deletePlace(db, p.id)).rejects.toBeInstanceOf(ApiError);
    await expect(updatePlace(db, p.id, { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('一覧から外した印', () => {
  it('外す・二度外しても1行・日ごとに引ける・戻す', async () => {
    await addHidden(db, { kind: 'photo', ref: 'AAA/L0/001', date: '2026-11-27' });
    await addHidden(db, { kind: 'photo', ref: 'AAA/L0/001', date: '2026-11-27' });
    await addHidden(db, { kind: 'event', ref: 'ev-1', date: '2026-11-27' });
    await addHidden(db, { kind: 'event', ref: 'ev-2', date: '2026-11-28' });
    expect((await listHiddenOn(db, '2026-11-27')).map((h) => `${h.kind}:${h.ref}`).sort()).toEqual(['event:ev-1', 'photo:AAA/L0/001']);
    expect(await removeHidden(db, { kind: 'photo', ref: 'AAA/L0/001' })).toEqual({ removed: true });
    expect(await removeHidden(db, { kind: 'photo', ref: 'AAA/L0/001' })).toEqual({ removed: false });
    expect((await listHiddenOn(db, '2026-11-27')).map((h) => h.ref)).toEqual(['ev-1']);
  });
});
