// 顔モザイクの書き出し（顔モザイク設計 §3.4）を、ローカルの D1・R2（miniflare）で通すテスト。
// schema.sql と migrations/0011 を一時フォルダの D1 に当ててから動かす（リポジトリの .wrangler は触らない）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ApiError } from '../http';
import { FACE_MODEL, faceFingerprint, maskedKeyFor, maskedPublicKeyFor, type PhotoFace } from './photo-face';
import { faceStates, saveFaces } from './photo-face-db';
import { copyPhotosForPublish, publicKeyFor, publicUrlFor } from './photos';

const root = new URL('../../../', import.meta.url).pathname;

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let env: Env;

const KEY = 'kakera/2026/10/12_1432_01JAAAAAAAAAAAAAAAAAAAAAAA_1.jpg';
const OTHER = 'kakera/2026/10/12_1432_01JAAAAAAAAAAAAAAAAAAAAAAA_10.jpg';
const body = (...keys: string[]) => keys.map((k) => `![](/api/photo/${k})`).join('\n\n');
const ORIGINAL = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3, 4]); // 素顔の原本のつもり
const MASKED = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const faceA: PhotoFace = { id: 'a1', x: 0.1, y: 0.1, w: 0.2, h: 0.2, source: 'auto', shown: false };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-face-'));
  const files = ['schema.sql', 'migrations/0011_photo_face.sql'];
  writeFileSync(join(dir, 'all.sql'), files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n'));
  execFileSync(
    join(root, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'kakera', '--local', '--persist-to', join(dir, 'state'), '--file', join(dir, 'all.sql')],
    { cwd: root, stdio: 'pipe' }
  );
  proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: join(dir, 'state', 'v3') } });
  env = proxy.env;
  await env.PHOTOS.put(KEY, ORIGINAL, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.PHOTOS.put(OTHER, ORIGINAL, { httpMetadata: { contentType: 'image/jpeg' } });
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function publicKeys(): Promise<string[]> {
  return (await env.IMAGES.list({ prefix: 'diary/' })).objects.map((o) => o.key).sort();
}

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(409);
    return (e as ApiError).message;
  }
  throw new Error('止まりませんでした');
}

describe('顔モザイクの書き出し（ローカル D1・R2）', () => {
  it('検出が済んでいない写真があると、何もコピーせずに止まる', async () => {
    const msg = await stopped(copyPhotosForPublish(env, [body(KEY)]));
    expect(msg).toContain('顔の検出が済んでいない写真が 1 枚');
    expect(await publicKeys()).toEqual([]);
  });

  it('顔が 0 件なら原本をそのまま出す（今までと同じ key）', async () => {
    await saveFaces(env.DB, KEY, [], FACE_MODEL);
    await saveFaces(env.DB, OTHER, [], FACE_MODEL);
    const map = await copyPhotosForPublish(env, [body(KEY, OTHER)]);
    expect(map.get(`/api/photo/${KEY}`)).toBe(publicUrlFor(publicKeyFor(KEY)));
    expect(await publicKeys()).toEqual([publicKeyFor(KEY), publicKeyFor(OTHER)].sort());
  });

  it('隠す枠があるのにモザイク済みの版が無ければ止まる（素顔の版は消さない＝何もしない）', async () => {
    await saveFaces(env.DB, KEY, [faceA]);
    const msg = await stopped(copyPhotosForPublish(env, [body(KEY)]));
    expect(msg).toContain('モザイクをかけた版がまだできていません');
    const [st] = await faceStates(env.DB, env.PHOTOS, [KEY]);
    expect(st).toMatchObject({ scanned: true, masked: false, fp: await faceFingerprint([faceA]) });
  });

  it('モザイク済みの版を出す。公開 key は指紋入りで、素顔の古い公開 key は消える（別の写真 _10 は残る）', async () => {
    const fp = (await faceFingerprint([faceA]))!;
    await env.PHOTOS.put(maskedKeyFor(KEY, fp), MASKED);
    expect((await faceStates(env.DB, env.PHOTOS, [KEY]))[0]!.masked).toBe(true);
    const map = await copyPhotosForPublish(env, [body(KEY)]);
    expect(map.get(`/api/photo/${KEY}`)).toBe(publicUrlFor(maskedPublicKeyFor(KEY, fp)));
    expect(await publicKeys()).toEqual([publicKeyFor(OTHER), maskedPublicKeyFor(KEY, fp)].sort());
    const copied = await env.IMAGES.get(maskedPublicKeyFor(KEY, fp));
    expect(new Uint8Array(await copied!.arrayBuffer())).toEqual(MASKED);
    // 原本は素顔のまま（かけら帳の中で見る写真）
    expect(new Uint8Array(await (await env.PHOTOS.get(KEY))!.arrayBuffer())).toEqual(ORIGINAL);
  });

  it('枠を直して出し直すと公開 key が変わり、前の指紋の公開 key は消える', async () => {
    const fp1 = (await faceFingerprint([faceA]))!;
    const moved = { ...faceA, x: 0.3 };
    const manual: PhotoFace = { id: 'mabc', x: 0.6, y: 0.6, w: 0.1, h: 0.1, source: 'manual', shown: false };
    await saveFaces(env.DB, KEY, [moved, manual]);
    const fp2 = (await faceFingerprint([moved, manual]))!;
    expect(fp2).not.toBe(fp1);
    await stopped(copyPhotosForPublish(env, [body(KEY)])); // 新しい指紋の版がまだ無い
    await env.PHOTOS.put(maskedKeyFor(KEY, fp2), MASKED);
    await copyPhotosForPublish(env, [body(KEY)]);
    expect(await publicKeys()).toEqual([publicKeyFor(OTHER), maskedPublicKeyFor(KEY, fp2)].sort());
  });

  it('全部「出す」にすると原本を出し、モザイクの公開 key は消える。出さない写真は検めない', async () => {
    await saveFaces(env.DB, KEY, [{ ...faceA, shown: true }]);
    const map = await copyPhotosForPublish(env, [body(KEY)]);
    expect(map.get(`/api/photo/${KEY}`)).toBe(publicUrlFor(publicKeyFor(KEY)));
    expect(await publicKeys()).toEqual([publicKeyFor(KEY), publicKeyFor(OTHER)].sort());

    const UNSCANNED = 'kakera/2026/10/12_1500_01JBBBBBBBBBBBBBBBBBBBBBBB_1.jpg';
    await env.PHOTOS.put(UNSCANNED, ORIGINAL);
    await copyPhotosForPublish(env, [body(KEY, UNSCANNED)], new Set([UNSCANNED]));
    expect(await publicKeys()).not.toContain(publicKeyFor(UNSCANNED));
  });
});
