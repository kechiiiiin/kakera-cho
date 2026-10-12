// 顔モザイクの書き出し（顔モザイク設計 §3.4）を、ローカルの D1・R2（miniflare）で通すテスト。
// schema.sql と migrations（0010 を除く）を一時フォルダの D1 に当ててから動かす（リポジトリの .wrangler は触らない）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ApiError } from '../http';
import { FACE_MODEL, faceFingerprint, maskedKeyFor, maskedPublicKeyFor, type PhotoFace } from './photo-face';
import { faceStates, isScanned, saveFaces } from './photo-face-db';
import { copyPhotosForPublish, dropOldPublicKeys, publicKeyFor, publicUrlFor } from './photos';
import { publishNikki, type BlogWriter } from './astro-blog';

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
  const files = [
    'schema.sql',
    ...[
      '0001_fts_trigram_search',
      '0002_link_card',
      '0003_name_map',
      '0004_katachi_kakera',
      '0005_katachi_written_order',
      '0006_photo_choice',
      '0007_nikki_description',
      '0008_publish_body',
      '0009_name_doc',
      '0011_photo_face',
    ].map((m) => `migrations/${m}.sql`),
  ];
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

/** 書き出しが通ったときと同じ順: コピー → （日記の commit） → 古い公開 key を消す。 */
async function publishPhotos(bodies: string[], skip: ReadonlySet<string> = new Set()): Promise<Map<string, string>> {
  const { map, stale } = await copyPhotosForPublish(env, bodies, skip);
  await dropOldPublicKeys(env, stale);
  return map;
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
    const map = await publishPhotos([body(KEY, OTHER)]);
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
    const map = await publishPhotos([body(KEY)]);
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
    await publishPhotos([body(KEY)]);
    expect(await publicKeys()).toEqual([publicKeyFor(OTHER), maskedPublicKeyFor(KEY, fp2)].sort());
  });

  it('全部「出す」にすると原本を出し、モザイクの公開 key は消える。出さない写真は検めない', async () => {
    await saveFaces(env.DB, KEY, [{ ...faceA, shown: true }]);
    const map = await publishPhotos([body(KEY)]);
    expect(map.get(`/api/photo/${KEY}`)).toBe(publicUrlFor(publicKeyFor(KEY)));
    expect(await publicKeys()).toEqual([publicKeyFor(KEY), publicKeyFor(OTHER)].sort());

    const UNSCANNED = 'kakera/2026/10/12_1500_01JBBBBBBBBBBBBBBBBBBBBBBB_1.jpg';
    await env.PHOTOS.put(UNSCANNED, ORIGINAL);
    await publishPhotos([body(KEY, UNSCANNED)], new Set([UNSCANNED]));
    expect(await publicKeys()).not.toContain(publicKeyFor(UNSCANNED));
  });

  it('古い公開 key は日記の commit が通ってから消す。commit に失敗したら残す（公開中の日記の写真を切らない）', async () => {
    // いまは素顔の版（publicKeyFor(KEY)）が公開中。隠す枠を足してモザイクの版を用意する
    const hide = { ...faceA, x: 0.5 };
    await saveFaces(env.DB, KEY, [hide]);
    const fp = (await faceFingerprint([hide]))!;
    await env.PHOTOS.put(maskedKeyFor(KEY, fp), MASKED);
    const before = await publicKeys();
    expect(before).toContain(publicKeyFor(KEY));

    const input = { date: '2026-10-12', title: 't', bodies: [body(KEY)], alreadyPublished: true };
    const testEnv = { ...env, BLOG_GITHUB_TOKEN: 'test', GITHUB_OWNER: 'o', BLOG_REPO: 'r' } as Env;
    const failing = {
      fileExists: async () => true,
      readFile: async () => null,
      putText: async () => {
        throw new ApiError(502, 'astro-blog に書けませんでした');
      },
    } as unknown as BlogWriter;
    await expect(publishNikki(testEnv, input, failing)).rejects.toThrow('astro-blog に書けませんでした');
    // 新しい版は置かれたが、古い素顔の版はまだ残っている（日記はまだ古い URL を指している）
    expect(await publicKeys()).toEqual([...before, maskedPublicKeyFor(KEY, fp)].sort());

    const written: string[] = [];
    const ok = {
      fileExists: async () => true,
      readFile: async () => null,
      putText: async (_ref: unknown, _path: string, content: string) => {
        written.push(content);
      },
    } as unknown as BlogWriter;
    await publishNikki(testEnv, input, ok);
    expect(written[0]).toContain(publicUrlFor(maskedPublicKeyFor(KEY, fp)));
    expect(await publicKeys()).toEqual([publicKeyFor(OTHER), maskedPublicKeyFor(KEY, fp)].sort());
  });

  it('古い公開 key を消せなかったら、消せなかった枚数を返す（日記の書き出しは失敗にしない）', async () => {
    const hide = { ...faceA, x: 0.55 };
    await saveFaces(env.DB, KEY, [hide]);
    const fp = (await faceFingerprint([hide]))!;
    await env.PHOTOS.put(maskedKeyFor(KEY, fp), MASKED);
    const images = env.IMAGES;
    const broken = {
      ...env,
      BLOG_GITHUB_TOKEN: 'test',
      GITHUB_OWNER: 'o',
      BLOG_REPO: 'r',
      IMAGES: {
        put: images.put.bind(images),
        get: images.get.bind(images),
        head: images.head.bind(images),
        list: images.list.bind(images),
        delete: async () => {
          throw new Error('R2 が応えません');
        },
      },
    } as unknown as Env;
    const ok = {
      fileExists: async () => true,
      readFile: async () => null,
      putText: async () => undefined,
    } as unknown as BlogWriter;
    const r = await publishNikki(broken, { date: '2026-10-12', title: 't', bodies: [body(KEY)], alreadyPublished: true }, ok);
    expect(r.staleLeft).toBe(1);
    // 古い版は残っている。次の書き出し（消せる状態）で拾われて消える
    expect((await publicKeys()).length).toBe(3);
    expect(await dropOldPublicKeys(env, [{ key: KEY, keep: maskedPublicKeyFor(KEY, fp) }])).toBe(0);
    expect(await publicKeys()).toEqual([publicKeyFor(OTHER), maskedPublicKeyFor(KEY, fp)].sort());
  });

  it('版の違うモデルで調べた印は、調べていないのと同じ（書き出しが止まり、画面が検出し直す）', async () => {
    await saveFaces(env.DB, KEY, [faceA], 'mediapipe-tasks-vision@0.0.1/old-model');
    const [st] = await faceStates(env.DB, env.PHOTOS, [KEY]);
    expect(st!.scanned).toBe(false);
    expect(await isScanned(env.DB, KEY)).toBe(false);
    const msg = await stopped(copyPhotosForPublish(env, [body(KEY)]));
    expect(msg).toContain('顔の検出が済んでいない写真が 1 枚');
    await saveFaces(env.DB, KEY, [faceA], FACE_MODEL);
    expect(await isScanned(env.DB, KEY)).toBe(true);
  });
});
