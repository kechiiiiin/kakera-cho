// iOS の日ごとの画面: listKakeraOn は JST のその日に書いたかけら全部（かたちの中も含む）を書いた順で返す。
// D1 はローカルの miniflare（一時フォルダ）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ulid } from '../ulid';
import { addKakeraToKatachi, createKatachi, insertKakera, listKakeraOn } from './db';

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
  '0012_show_time',
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-day-'));
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

describe('listKakeraOn', () => {
  it('JST の 0:00〜23:59 だけ・書いた順・かたちの中のかけらも katachi_id つきで出る', async () => {
    const ids = { before: ulid(), first: ulid(), late: ulid(), inKatachi: ulid(), after: ulid() };
    await insertKakera(db, { id: ids.before, body: '前の日の 23:59', written_at: '2026-11-22T23:59:00+09:00' });
    await insertKakera(db, { id: ids.late, body: 'その日の 23:59', written_at: '2026-11-23T23:59:00+09:00' });
    await insertKakera(db, { id: ids.first, body: 'その日の 0:00', written_at: '2026-11-23T00:00:00+09:00' });
    await insertKakera(db, { id: ids.inKatachi, body: 'かたちの中', written_at: '2026-11-23T12:00:00+09:00' });
    await insertKakera(db, { id: ids.after, body: '次の日の 0:00', written_at: '2026-11-24T00:00:00+09:00' });
    const katachiId = ulid();
    await createKatachi(db, { id: katachiId, title: 'ある日', date: '2026-11-23', kakera_ids: [] });
    await addKakeraToKatachi(db, katachiId, [ids.inKatachi]);

    const got = await listKakeraOn(db, '2026-11-23');
    expect(got.map((k) => k.id)).toEqual([ids.first, ids.inKatachi, ids.late]);
    expect(Object.keys(got[0]!).sort()).toEqual(['body', 'id', 'katachi_id', 'updated_at', 'written_at']);
    expect(got.map((k) => k.katachi_id)).toEqual([null, katachiId, null]);
    expect((await listKakeraOn(db, '2026-11-24')).map((k) => k.id)).toEqual([ids.after]);
  });
});
