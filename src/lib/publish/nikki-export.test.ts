// 書き出しの組み立てを、ローカルの D1（miniflare）で通すテスト（公開名変換設計・記号方式の移行とテスト §6 の 15・19・22 ほか）。
// ⚠️ 仮名の辞書だけで書く。家族の実名を書かない（このリポジトリは public）。
// schema.sql と migrations/0001〜0009 を一時フォルダの D1 に当ててから動かす（リポジトリの .wrangler は触らない）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { getKatachiDetail, updateKakeraBody } from '../kakera/db';
import { deleteNameEntry, insertNameEntry, listNameMap, pickKakera, updateNameEntry } from '../names/db';
import { resolveShape } from '../names/doc';
import {
  chooseRef,
  deletePublishDoc,
  diaryDocViews,
  dictRev,
  savePublishText,
  syncDiaryDocs,
  type DocView,
} from '../names/doc-db';
import { ulid } from '../ulid';
import { publishNikki, type BlogWriter } from './astro-blog';
import { prepareNikkiExport } from './nikki-export';

const root = new URL('../../../', import.meta.url).pathname;
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
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

const K = ulid();
const A = ulid();
const B = ulid();
const PHOTO = 'kakera/2026/09/a.jpg';
const BODY_A = `太郎が来た。\n\n![花子の写真](/api/photo/${PHOTO})`;
const BODY_B = '花子と次の日。';
const TITLE = '太郎の日';
const DESCRIPTION = '花子と出かけた';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-test-'));
  const files = ['schema.sql', ...MIGRATIONS.map((m) => `migrations/${m}.sql`)];
  writeFileSync(join(dir, 'all.sql'), files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n'));
  execFileSync(
    join(root, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'kakera', '--local', '--persist-to', join(dir, 'state'), '--file', join(dir, 'all.sql')],
    { cwd: root, stdio: 'pipe' }
  );
  proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: join(dir, 'state', 'v3') } });
  db = proxy.env.DB;

  const now = '2026-09-14T09:00:00+09:00';
  await db.batch([
    db.prepare('INSERT INTO kakera (id, body, written_at, updated_at) VALUES (?, ?, ?, ?)').bind(A, BODY_A, now, now),
    db.prepare('INSERT INTO kakera (id, body, written_at, updated_at) VALUES (?, ?, ?, ?)').bind(B, BODY_B, '2026-09-14T10:00:00+09:00', now),
    db
      .prepare('INSERT INTO katachi (id, date, title, updated_at, description) VALUES (?, ?, ?, ?, ?)')
      .bind(K, '2026-09-14', TITLE, now, DESCRIPTION),
    db.prepare('INSERT INTO katachi_kakera (katachi_id, kakera_id) VALUES (?, ?)').bind(K, A),
    db.prepare('INSERT INTO katachi_kakera (katachi_id, kakera_id) VALUES (?, ?)').bind(K, B),
  ]);
  for (const [source, target] of [
    ['太郎', '長男'],
    ['花子', '妻'],
    ['次', '次男'],
    ['太郎々', '太郎々'],
  ] as const) {
    await insertNameEntry(db, { source, target });
  }
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function kakeraSnapshot(): Promise<string> {
  const { results } = await db.prepare('SELECT id, body, written_at, updated_at FROM kakera ORDER BY id').all();
  return JSON.stringify(results);
}

async function count(sql: string): Promise<number> {
  return (await db.prepare(sql).first<{ n: number }>())!.n;
}

/** 変換ページを開く（name-choice の POST と同じ）。 */
async function openPage(): Promise<{ views: DocView[]; dict_rev: string }> {
  const detail = await getKatachiDetail(db, K);
  const chosen = pickKakera(detail, [A, B]);
  const dict = await listNameMap(db);
  const docs = await syncDiaryDocs(db, K, chosen, TITLE, detail.katachi.description, dict, { write: true, repair: true });
  return { views: diaryDocViews(docs, chosen), dict_rev: await dictRev(dict) };
}

function used(views: DocView[]): DocView[] {
  const pick = (seg: string, kind: DocView['kind']) => views.find((v) => v.seg === seg && v.kind === kind);
  return [
    pick('title', 'title')!,
    pick('description', 'description')!,
    pick(A, 'publish') ?? pick(A, 'kakera')!,
    pick(B, 'publish') ?? pick(B, 'kakera')!,
  ];
}

function exportInput(page: { views: DocView[]; dict_rev: string }, extra: Record<string, unknown> = {}) {
  const u = used(page.views);
  return {
    kakera_ids: [A, B],
    title: '',
    choices: u.flatMap((d) => d.refs.map((r) => ({ ref_id: r.id, action: r.action, ...(r.text ? { text: r.text } : {}) }))),
    doc_revs: u.map((d) => ({ doc_id: d.doc_id, rev: d.rev })),
    dict_rev: page.dict_rev,
    photos: [],
    ...extra,
  };
}

const refIn = (views: DocView[], seg: string, kind: DocView['kind'], source: string) =>
  views.find((v) => v.seg === seg && v.kind === kind)!.refs.find((r) => r.source === source)!;

describe('書き出しの組み立て（ローカル D1）', () => {
  let baseline = '';

  it('変換ページを開くと文書ができ、全記号が辞書どおり。原本は変わらない', async () => {
    const before = await kakeraSnapshot();
    const page = await openPage();
    expect(await count('SELECT count(*) AS n FROM name_doc')).toBe(4);
    expect(page.views.every((v) => v.refs.every((r) => r.action === 'approve'))).toBe(true);
    // 記号の JSON に実名を入れない
    expect(page.views.map((v) => JSON.stringify(v.segments)).join('')).not.toMatch(/太郎|花子/);
    expect(await kakeraSnapshot()).toBe(before);
    baseline = before;
  });

  it('解いてから写真を除く。書き出しの組み立ては文書を書き換えない', async () => {
    const page = await openPage();
    const docsBefore = await count('SELECT count(*) AS n FROM name_doc');
    const p = await prepareNikkiExport(db, K, exportInput(page, { photos: [{ kakera_id: A, key: PHOTO }] }));
    expect(p.publish.title).toBe('長男の日');
    expect(p.publish.description).toBe('妻と出かけた');
    expect(p.publish.bodies).toEqual(['長男が来た。', '妻と次男の日。']);
    expect(p.publish.hiddenPhotoKeys?.has(PHOTO)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM name_doc')).toBe(docsBefore);
    expect(await kakeraSnapshot()).toBe(baseline);
  });

  it('拒否が残ると念押しが要る', async () => {
    let page = await openPage();
    await chooseRef(db, K, await listNameMap(db), { ref_id: refIn(page.views, 'title', 'title', '太郎').id, action: 'reject' });
    page = await openPage();
    await expect(prepareNikkiExport(db, K, exportInput(page))).rejects.toMatchObject({ status: 409 });
    const p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }));
    expect(p.publish.title).toBe('太郎の日');
    await chooseRef(db, K, await listNameMap(db), { ref_id: refIn(page.views, 'title', 'title', '太郎').id, action: 'approve' });
  });

  it('19. 開いた後に原本を直して書き出す → 409。開き直すと、直した場所の選択だけ外れて知らせる', async () => {
    let page = await openPage();
    await chooseRef(db, K, await listNameMap(db), { ref_id: refIn(page.views, A, 'kakera', '太郎').id, action: 'edit', text: '兄' });
    page = await openPage();
    await updateKakeraBody(db, A, `太朗が来た！\n\n![花子の写真](/api/photo/${PHOTO})`);
    baseline = await kakeraSnapshot();
    await expect(prepareNikkiExport(db, K, exportInput(page))).rejects.toMatchObject({
      status: 409,
      message: '内容が変わりました。開き直してください。',
    });
    page = await openPage();
    const a = page.views.find((v) => v.seg === A && v.kind === 'kakera')!;
    expect(a.lost_choices).toEqual([{ source: '太郎', action: 'edit', text: '兄', now: null }]);
    const p = await prepareNikkiExport(db, K, exportInput(page));
    expect(p.publish.bodies[0]).toContain('太朗が来た！');
    // 知らせは一度だけ
    expect((await openPage()).views.find((v) => v.seg === A && v.kind === 'kakera')!.lost_choices).toEqual([]);
  });

  it('日記用に直す: 保存しても選択が消えない。開いた後に別のタブで選択を変えて保存 → 409', async () => {
    let page = await openPage();
    const dict = await listNameMap(db);
    await chooseRef(db, K, dict, { ref_id: refIn(page.views, B, 'kakera', '花子').id, action: 'reject' });
    page = await openPage();
    const bDoc = page.views.find((v) => v.seg === B && v.kind === 'kakera')!;
    const d0 = resolveShape({ segments: bDoc.segments!, refs: bDoc.refs }, dict).text;
    expect(d0).toBe('花子と次男の日。');
    const k = (await getKatachiDetail(db, K)).kakera.find((x) => x.id === B)!;
    const saved = await savePublishText(db, K, k, dict, d0, `${d0}また花子と行こう。`);
    expect(saved.publish).not.toBeNull();
    page = await openPage();
    const pub = page.views.find((v) => v.seg === B && v.kind === 'publish')!;
    expect(pub.refs.map((r) => [r.source, r.action])).toEqual([
      ['花子', 'reject'],
      ['次', 'approve'],
      ['花子', 'approve'],
    ]);
    const p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }));
    expect(p.publish.bodies[1]).toBe('花子と次男の日。また妻と行こう。');

    // 別のタブで選択を変えた後に、古い欄で保存
    const d0b = resolveShape({ segments: pub.segments!, refs: pub.refs }, dict).text;
    await chooseRef(db, K, dict, { ref_id: pub.refs[2]!.id, action: 'edit', text: '連れ' });
    await expect(savePublishText(db, K, k, dict, d0b, d0b + '！')).rejects.toMatchObject({ status: 409 });
    // 原本側の選択は別に残っている
    expect(refIn((await openPage()).views, B, 'kakera', '花子').action).toBe('reject');
    expect(await kakeraSnapshot()).toBe(baseline);
  });

  it('14. 辞書の変更: 開いた後なら 409。置き換え先の変更は保存済みの日記用の文にも効く。語を消すと手で直した言葉は残る', async () => {
    let page = await openPage();
    const entries = await listNameMap(db);
    const hanako = entries.find((e) => e.source === '花子')!;
    await updateNameEntry(db, hanako.id, { source: '花子', target: '連れ合い' });
    await expect(prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }))).rejects.toMatchObject({ status: 409 });
    page = await openPage();
    let p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }));
    expect(p.publish.bodies[1]).toBe('花子と次男の日。また連れと行こう。');
    expect(p.publish.description).toBe('連れ合いと出かけた');

    await deleteNameEntry(db, entries.find((e) => e.source === '次')!.id);
    await deleteNameEntry(db, hanako.id);
    page = await openPage();
    p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }));
    // 辞書どおりだった「次」は実名に戻り、手で直した「連れ」は残り、拒否の「花子」は実名のまま
    expect(p.publish.bodies[1]).toBe('花子と次の日。また連れと行こう。');
    await insertNameEntry(db, { source: '花子', target: '妻' });
    await insertNameEntry(db, { source: '次', target: '次男' });
  });

  it('15. 解けない: segments を壊す・記号の行を消す → 409（開き直すと原本の文書は作り直せる）', async () => {
    let page = await openPage();
    await db.prepare("UPDATE name_doc SET segments = '{' WHERE kind = 'kakera' AND kakera_id = ?").bind(A).run();
    await expect(prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/かけら 1の名前の記号が読めません/),
    });
    page = await openPage();
    await expect(prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }))).resolves.toBeTruthy();

    const pub = page.views.find((v) => v.seg === B && v.kind === 'publish')!;
    await db.prepare('DELETE FROM name_ref WHERE id = ?').bind(pub.refs[0]!.id).run();
    page = await openPage();
    await expect(prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }))).rejects.toMatchObject({ status: 409 });
    expect(page.views.find((v) => v.seg === B && v.kind === 'publish')!.segments).toBeNull();
    // 原本に戻す
    expect(await deletePublishDoc(db, K, B)).toBe(true);
    page = await openPage();
    const p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true }));
    // 14 で「花子」を辞書から一度消したので、原本側の拒否は捨てられ、足し直した後は辞書どおり
    expect(p.publish.bodies[1]).toBe('妻と次男の日。');
  });

  it('書き出しの .md（書き込み関数を差し替えて中身を確かめる）。22. 原本は最初から変わっていない', async () => {
    const page = await openPage();
    const p = await prepareNikkiExport(db, K, exportInput(page, { confirm_real_names: true, photos: [{ kakera_id: A, key: PHOTO }] }));
    const written: { path: string; content: string }[] = [];
    const gh = {
      fileExists: async () => false,
      readFile: async () => null,
      putText: async (_ref: unknown, path: string, content: string) => {
        written.push({ path, content });
      },
    } as unknown as BlogWriter;
    const env = { ...proxy.env, BLOG_GITHUB_TOKEN: 'test', GITHUB_OWNER: 'o', BLOG_REPO: 'r' } as Env;
    await publishNikki(env, p.publish, gh);
    expect(written.map((w) => w.path)).toEqual(['src/content/diary/2026-09-14.md']);
    expect(written[0]!.content).toBe(
      [
        '---',
        'title: "長男の日"',
        'description: "妻と出かけた"',
        'pubDate: 2026-09-14',
        'tags: []',
        'draft: false',
        '---',
        '',
        '太朗が来た！',
        '',
        '---',
        '',
        '妻と次男の日。',
        '',
      ].join('\n')
    );
    expect(written[0]!.content).not.toContain(PHOTO);
    expect(await kakeraSnapshot()).toBe(baseline);
  });
});
