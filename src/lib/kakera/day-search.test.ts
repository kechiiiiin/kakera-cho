// 段階5: 月カレンダーの日ごとの数・日付つきの検索（かたちの検索の形は変えない）・全期間の書き出し。
// D1 はローカルの miniflare（一時フォルダ）。schema.sql → 0001〜0013。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ulid } from '../ulid';
import { addKakeraToKatachi, createKatachi, insertKakera, searchKatachi } from './db';
import { insertPlace, putDayMood } from './day-db';
import { exportRows, isMonthKey, monthDays, nextMonth, renderExport, searchDays } from './day-search';

const root = join(__dirname, '../../..');
const MIGRATIONS = [
  '0001_fts_trigram_search', '0002_link_card', '0003_name_map', '0004_katachi_kakera', '0005_katachi_written_order',
  '0006_photo_choice', '0007_nikki_description', '0008_publish_body', '0009_name_doc', '0010_drop_position_choice',
  '0011_photo_face', '0012_show_time', '0013_day_place',
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
const ids = { flow: ulid(), inKatachi: ulid(), other: ulid(), lateNov: ulid(), dec: ulid() };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-day-search-'));
  const files = ['schema.sql', ...MIGRATIONS.map((m) => `migrations/${m}.sql`)];
  writeFileSync(join(dir, 'all.sql'), files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n'));
  execFileSync(
    join(root, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'kakera', '--local', '--persist-to', join(dir, 'state'), '--file', join(dir, 'all.sql')],
    { cwd: root, stdio: 'pipe' }
  );
  proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: join(dir, 'state', 'v3') } });
  db = proxy.env.DB;

  await insertKakera(db, { id: ids.flow, body: '流れにある銀杏並木のかけら', written_at: '2026-11-03T09:00:00+09:00' });
  await insertKakera(db, { id: ids.inKatachi, body: 'かたちの中の銀杏並木\n二行目', written_at: '2026-11-03T18:30:00+09:00' });
  await insertKakera(db, { id: ids.other, body: '別の話', written_at: '2026-11-10T07:00:00+09:00' });
  await insertKakera(db, { id: ids.lateNov, body: '月末の夜', written_at: '2026-11-30T23:59:00+09:00' });
  await insertKakera(db, { id: ids.dec, body: '十二月', written_at: '2026-12-01T00:00:00+09:00' });
  const katachiId = ulid();
  await createKatachi(db, { id: katachiId, title: '十一月三日', date: '2026-11-03', kakera_ids: [] });
  await addKakeraToKatachi(db, katachiId, [ids.inKatachi]);
  await insertPlace(db, { id: ulid(), at: '2026-11-03T10:00:00+09:00', name: '銀杏並木の公園', lat: 35.6, lng: 139.7, source: 'manual' });
  await insertPlace(db, { id: ulid(), at: '2026-11-20T12:00:00+09:00', name: '駅前', lat: null, lng: null, source: 'visit' });
  await putDayMood(db, '2026-11-03', '嬉');
  await putDayMood(db, '2026-11-25', '疲'); // 気分だけの日
  await putDayMood(db, '2026-11-26', null); // 外した日は出ない
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('月カレンダー', () => {
  it('月の形', () => {
    expect(isMonthKey('2026-11')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-1')).toBe(false);
    expect(nextMonth('2026-12')).toBe('2027-01');
  });

  it('その月の日ごとに かけら・場所の数と気分（JST の月の境目）', async () => {
    expect(await monthDays(db, '2026-11')).toEqual([
      { date: '2026-11-03', kakera: 2, places: 1, mood: '嬉' },
      { date: '2026-11-10', kakera: 1, places: 0, mood: null },
      { date: '2026-11-20', kakera: 0, places: 1, mood: null },
      { date: '2026-11-25', kakera: 0, places: 0, mood: '疲' },
      { date: '2026-11-30', kakera: 1, places: 0, mood: null },
    ]);
    expect(await monthDays(db, '2026-12')).toEqual([{ date: '2026-12-01', kakera: 1, places: 0, mood: null }]);
    expect(await monthDays(db, '2026-10')).toEqual([]);
  });
});

describe('日付つきの検索', () => {
  it('かけらは流れもかたちの中も、場所は名前で。新しい順・日時つき', async () => {
    const r = await searchDays(db, '銀杏並木');
    expect(r.kakera.map((k) => k.id)).toEqual([ids.inKatachi, ids.flow]);
    expect(r.kakera[0]!.written_at).toBe('2026-11-03T18:30:00+09:00');
    expect(r.kakera[0]!.excerpt).toContain('銀杏並木');
    expect(r.places.map((p) => p.name)).toEqual(['銀杏並木の公園']);
    // 2文字は LIKE
    expect((await searchDays(db, '駅前')).places.map((p) => p.name)).toEqual(['駅前']);
    expect(await searchDays(db, '  ')).toEqual({ kakera: [], places: [] });
  });

  it('かたちの検索（/api/search の results）は今までどおり、かたちの中のかけらだけ', async () => {
    const results = await searchKatachi(db, '銀杏並木');
    expect(results.map((r) => r.date)).toEqual(['2026-11-03']);
    expect(results[0]!.matches.map((m) => m.kakera_id)).toEqual([ids.inKatachi]);
    expect(Object.keys(results[0]!).sort()).toEqual(['date', 'description', 'has_nikki', 'id', 'matches', 'title', 'updated_at']);
  });
});

describe('書き出し', () => {
  it('日付順に 日付・気分・場所・かけら。本文は2字下げ', async () => {
    const text = renderExport(await exportRows(db), '2026-11-28T14:00:00+09:00');
    expect(text.startsWith('かけら帳 書き出し（全期間）\n書き出した日時: 2026-11-28 14:00\n日数: 6　かけら: 5　場所: 2\n')).toBe(true);
    expect(text).toContain(
      [
        '==== 2026-11-03（火） ====',
        '気分: 嬉',
        '場所:',
        '  10:00  銀杏並木の公園',
        'かけら:',
        '  [09:00]',
        '    流れにある銀杏並木のかけら',
        '  [18:30]',
        '    かたちの中の銀杏並木',
        '    二行目',
        '',
      ].join('\n')
    );
    expect(text).toContain('==== 2026-11-25（水） ====\n気分: 疲\n\n');
    const order = ['2026-11-03', '2026-11-10', '2026-11-20', '2026-11-25', '2026-11-30', '2026-12-01'].map((d) => text.indexOf(`==== ${d}`));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
    expect(text).toContain('予定と写真は端末にしか無いので入っていません。');
  });
});
