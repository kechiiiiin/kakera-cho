// 公開の約束のテスト（かけら言葉リンク設計 §2.3「公開」・§3）: 公開する日記の本文・説明文・X に `[[ ]]` を出さない。
// `[[実名]]` でも実名が残らず公開名になる。fail-closed の 409 が今までどおり動く。
// ⚠️ 仮名の辞書だけで書く。家族の実名を書かない（このリポジトリは public）。
// schema.sql と migrations を一時フォルダの D1 に当ててから動かす（リポジトリの .wrangler は触らない）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { getKakera, getKatachiDetail, getWordDetail, listWords, updateKakera, deleteKakera } from '../kakera/db';
import { insertNameEntry, listNameMap, pickKakera } from '../names/db';
import { assembleNikki, stripResolvedWikilinks } from '../names/assemble';
import { buildRealShape, resolveShape } from '../names/doc';
import { diaryDocViews, dictRev, savePublishText, syncDiaryDocs, type DocView } from '../names/doc-db';
import { ulid } from '../ulid';
import { publishNikki, type BlogWriter } from './astro-blog';
import { prepareNikkiExport } from './nikki-export';
import { GET as wordsGet, POST as wordsPost } from '../../pages/api/words';

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
  '0012_show_time',
];

let dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

const K = ulid();
const K2 = ulid();
const A = ulid();
const B = ulid();
const C = ulid();
const FLOW = ulid();
const TITLE = '[[太郎]]の日';
const DESCRIPTION = '[[花子]]と出かけた';
const BODY_A = '[[太郎]]が[[京都]]に来た。\n\n**[[花子]]**と`[[コード]]`。';
const BODY_B = '[[太郎]]と[[奈良]]。';
const dict = [
  { id: '1', source: '太郎', target: '長男' },
  { id: '2', source: '花子', target: '妻' },
];

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
  const kakera = (id: string, body: string, at: string) =>
    db.prepare('INSERT INTO kakera (id, body, written_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, body, at, now);
  await db.batch([
    kakera(A, BODY_A, '2026-09-14T09:00:00+09:00'),
    kakera(B, BODY_B, '2026-09-14T10:00:00+09:00'),
    kakera(C, '実[[在]]の[[京都]]', '2026-09-15T10:00:00+09:00'),
    kakera(FLOW, '流れの[[京都]]と[[京都]]。`[[コード]]`\n\n![](/api/photo/kakera/a.jpg)', '2026-09-16T10:00:00+09:00'),
    db.prepare('INSERT INTO katachi (id, date, title, updated_at, description) VALUES (?, ?, ?, ?, ?)').bind(K, '2026-09-14', TITLE, now, DESCRIPTION),
    db.prepare('INSERT INTO katachi (id, date, title, updated_at, description) VALUES (?, ?, ?, ?, ?)').bind(K2, '2026-09-15', '', now, ''),
    db.prepare('INSERT INTO katachi_kakera (katachi_id, kakera_id) VALUES (?, ?)').bind(K, A),
    db.prepare('INSERT INTO katachi_kakera (katachi_id, kakera_id) VALUES (?, ?)').bind(K, B),
    db.prepare('INSERT INTO katachi_kakera (katachi_id, kakera_id) VALUES (?, ?)').bind(K2, C),
  ]);
  await insertNameEntry(db, { source: '太郎', target: '長男' });
  await insertNameEntry(db, { source: '花子', target: '妻' });
  await insertNameEntry(db, { source: '実在', target: '仮置き' });
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openPage(katachiId: string, ids: string[], title = TITLE) {
  const detail = await getKatachiDetail(db, katachiId);
  const chosen = pickKakera(detail, ids);
  const entries = await listNameMap(db);
  const docs = await syncDiaryDocs(db, katachiId, chosen, title, detail.katachi.description, entries, { write: true, repair: true });
  return { views: diaryDocViews(docs, chosen), dict_rev: await dictRev(entries) };
}

function exportInput(page: { views: DocView[]; dict_rev: string }, ids: string[], segs: string[], extra: Record<string, unknown> = {}) {
  const pick = (seg: string) =>
    page.views.find((v) => v.seg === seg && v.kind === 'publish') ?? page.views.find((v) => v.seg === seg && v.kind !== 'publish')!;
  const used = segs.map(pick);
  return {
    kakera_ids: ids,
    title: '',
    choices: used.flatMap((d) => d.refs.map((r) => ({ ref_id: r.id, action: r.action, ...(r.text ? { text: r.text } : {}) }))),
    doc_revs: used.map((d) => ({ doc_id: d.doc_id, rev: d.rev })),
    dict_rev: page.dict_rev,
    photos: [],
    ...extra,
  };
}

describe('公開の約束（ローカル D1 で書き出しまで通す）', () => {
  it('変換ページを開くと [[太郎]] が名前の記号になる（括弧の中でも名前として検出される）', async () => {
    const page = await openPage(K, [A, B]);
    const a = page.views.find((v) => v.seg === A && v.kind === 'kakera')!;
    expect(a.refs.map((r) => r.source)).toEqual(['太郎', '花子']);
    expect(page.views.find((v) => v.seg === 'title')!.refs.map((r) => r.source)).toEqual(['太郎']);
    expect(page.views.find((v) => v.seg === 'description')!.refs.map((r) => r.source)).toEqual(['花子']);
  });

  it('書き出す .md の本文・説明文・タイトル・commit メッセージに括弧も実名も無く、公開名になっている。コードの中は残す。原本は括弧のまま', async () => {
    const page = await openPage(K, [A, B]);
    const p = await prepareNikkiExport(db, K, exportInput(page, [A, B], ['title', 'description', A, B]));
    expect(p.publish.title).toBe('長男の日');
    expect(p.publish.description).toBe('妻と出かけた');
    expect(p.publish.bodies).toEqual(['長男が京都に来た。\n\n**妻**と`[[コード]]`。', '長男と奈良。']);

    const written: { path: string; content: string; message: string }[] = [];
    const gh = {
      fileExists: async () => false,
      readFile: async () => null,
      putText: async (_ref: unknown, path: string, content: string, message: string) => {
        written.push({ path, content, message });
      },
    } as unknown as BlogWriter;
    const env = { ...proxy.env, BLOG_GITHUB_TOKEN: 'test', GITHUB_OWNER: 'o', BLOG_REPO: 'r' } as Env;
    await publishNikki(env, p.publish, gh);
    expect(written.length).toBe(1);
    const { content, message } = written[0]!;
    expect(content.replace('`[[コード]]`', '')).not.toMatch(/\[\[|\]\]/);
    expect(content).not.toMatch(/太郎|花子/);
    expect(content).toContain('title: "長男の日"');
    expect(content).toContain('description: "妻と出かけた"');
    expect(content).toContain('長男が京都に来た');
    expect(message).not.toMatch(/\[\[|太郎/);

    // 原本は括弧のまま
    expect((await getKakera(db, A))!.body).toBe(BODY_A);
  });

  it('fail-closed: 括弧が名前を割っている（実[[在]]）と、外した後に現れる実名で 409', async () => {
    const page = await openPage(K2, [C], '');
    await expect(prepareNikkiExport(db, K2, exportInput(page, [C], ['title', C]))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('記号になっていない名前'),
    });
  });

  it('fail-closed: 打ち消しで作った括弧が残るなら 409', async () => {
    await updateKakera(db, C, { body: '[\\[京都]]' });
    const page = await openPage(K2, [C], '');
    await expect(prepareNikkiExport(db, K2, exportInput(page, [C], ['title', C]))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('括弧'),
    });
  });

  it('fail-closed: URL の中の括弧は外さず 409（https://example.com/[[仮名]]）', async () => {
    for (const body of ['https://example.com/[[太郎]]', 'https://example.com/あ[[太郎]]', 'www.example.com/[[太郎]]', '<mailto:[[太郎]]>', '[a](/[[太郎]])']) {
      await updateKakera(db, C, { body });
      const page = await openPage(K2, [C], '');
      await expect(prepareNikkiExport(db, K2, exportInput(page, [C], ['title', C]))).rejects.toMatchObject({ status: 409 });
    }
  });

  it('[[ を含まない URL の書き出しは1バイトも変えない。URL の外の言葉は今までどおり外す', async () => {
    for (const body of [
      'https://example.com/a_(b)?c=1&d=[x]',
      'https://example.com/あい',
      'www.example.com/a]]',
      '[a](https://example.com/b "題")',
      '![](https://example.com/c.jpg)',
      '<https://example.com/d>',
    ]) {
      await updateKakera(db, C, { body });
      const page = await openPage(K2, [C], '');
      const p = await prepareNikkiExport(db, K2, exportInput(page, [C], ['title', C]));
      expect(p.publish.bodies).toEqual([body]);
    }
    await updateKakera(db, C, { body: 'https://example.com/x [[太郎]]\n[[https://example.com/y]]\n[[太郎]](/rel)' });
    const page = await openPage(K2, [C], '');
    const p = await prepareNikkiExport(db, K2, exportInput(page, [C], ['title', C]));
    expect(p.publish.bodies).toEqual(['https://example.com/x 長男\nhttps://example.com/y\n長男(/rel)']);
  });

  it('fail-closed: 開いた後に本文が変わったら今までどおり 409', async () => {
    const page = await openPage(K, [A, B]);
    await updateKakera(db, B, { body: '[[太郎]]と[[奈良]]。直した' });
    await expect(prepareNikkiExport(db, K, exportInput(page, [A, B], ['title', 'description', A, B]))).rejects.toMatchObject({ status: 409 });
    await updateKakera(db, B, { body: BODY_B });
  });

  it('日記用に直す: 括弧を外した欄で保存しても、名前の選択は残り、書き出しに括弧も実名も出ない', async () => {
    const page = await openPage(K, [A, B]);
    const b = page.views.find((v) => v.seg === B && v.kind === 'kakera')!;
    await db.prepare("UPDATE name_ref SET action = 'edit', text = '仮の子' WHERE id = ?").bind(b.refs[0]!.id).run();
    const reopened = await openPage(K, [A, B]);
    const kb = reopened.views.find((v) => v.seg === B && v.kind === 'kakera')!;
    expect(kb.refs[0]!.action).toBe('edit');

    const entries = await listNameMap(db);
    const shape = { segments: kb.segments!, refs: kb.refs };
    const base = resolveShape(shape, entries).text;
    expect(base).toBe('[[仮の子]]と[[奈良]]。');
    const k = (await getKakera(db, B))!;
    const saved = await savePublishText(db, K, k, entries, base, '仮の子と奈良。あとから。');
    expect(saved.publish!.shape!.refs[0]).toMatchObject({ source: '太郎', action: 'edit', text: '仮の子' });

    const again = await openPage(K, [A, B]);
    const p = await prepareNikkiExport(db, K, exportInput(again, [A, B], ['title', 'description', A, B]));
    expect(p.publish.bodies[1]).toBe('仮の子と奈良。あとから。');
    expect((await getKakera(db, B))!.body).toBe(BODY_B);
  });
});

describe('組み立て（純関数）', () => {
  const part = (seg: string, text: string, body: boolean) => {
    let n = 0;
    return { seg, label: seg, shape: buildRealShape(text, dict, () => `${seg}${n++}`), expected: text, body };
  };

  it('公開名に記号があっても（打ち消されても）括弧ごと外れる', () => {
    const d = [{ id: '1', source: '太郎', target: '仮]名' }];
    let n = 0;
    const shape = buildRealShape('[[太郎]]', d, () => `b${n++}`);
    const out = assembleNikki({ title: part('t', '題', false), description: null, bodies: [{ seg: 'b', label: 'b', shape, expected: '[[太郎]]', body: true }] }, d);
    expect(out.bodies[0]!.text).toBe('仮\\]名');
  });

  it('記号の範囲は外した後の位置に写る（印と拒否の数え方が狂わない）', () => {
    const out = assembleNikki({ title: part('t', '[[太郎]]', false), description: null, bodies: [part('b', 'あ[[太郎]]い[[花子]]', true)] }, dict);
    expect(out.title.text).toBe('長男');
    expect(out.bodies[0]!.text).toBe('あ長男い妻');
    expect(out.bodies[0]!.spans.map((s) => out.bodies[0]!.text.slice(s.start, s.end))).toEqual(['長男', '妻']);
  });

  it('[[実名]](安全な url) はリンクのまま。表示文字の実名は置き換わる', () => {
    const out = assembleNikki({ title: part('t', '題', false), description: null, bodies: [part('b', '[[太郎]](https://example.com/x)', true)] }, dict);
    expect(out.bodies[0]!.text).toBe('[[長男]](https://example.com/x)');
  });

  it('変換ページの見せ方（stripResolvedWikilinks）でも括弧が出ず、印は名前の上に残る', () => {
    let n = 0;
    const shape = buildRealShape('[[太郎]]と[[京都]]', dict, () => `s${n++}`);
    const r = resolveShape(shape, dict);
    const shown = stripResolvedWikilinks(r.text, r.spans, false);
    expect(shown.text).toBe('長男と京都');
    expect(shown.text.slice(shown.spans[0]!.start, shown.spans[0]!.end)).toBe('長男');
  });
});

describe('ことば（listWords・getWordDetail）', () => {
  it('索引は新しく書いた順で、個数と日付が正しい。同じかけらの二度書きは 1。コードの中は数えない', async () => {
    await updateKakera(db, C, { body: '実[[在]]の[[京都]]' });
    const words = await listWords(db);
    expect(words[0]).toEqual({ word: '京都', count: 3, last_written_at: '2026-09-16T10:00:00+09:00' });
    expect(words.find((w) => w.word === '奈良')).toEqual({ word: '奈良', count: 1, last_written_at: '2026-09-14T10:00:00+09:00' });
    expect(words.map((w) => w.word)).not.toContain('コード');
  });

  it('言葉のページは かけらたち と かたち の両方を新しい順に、居場所つきで返す', async () => {
    const d = await getWordDetail(db, '京都');
    expect(d.word).toBe('京都');
    expect(d.kakera.map((k) => [k.id, k.katachi_id, k.katachi_date])).toEqual([
      [FLOW, null, null],
      [C, K2, '2026-09-15'],
      [A, K, '2026-09-14'],
    ]);
    expect(d.cards).toEqual({});
  });

  it('書式つきで囲んだ言葉も、記号なしの言葉で引ける。% や _ は特別扱いされない', async () => {
    await updateKakera(db, C, { body: '[[**実**感]]と[[100%]]' });
    expect((await getWordDetail(db, '実感')).kakera.map((k) => k.id)).toEqual([C]);
    expect((await listWords(db)).map((w) => w.word)).not.toContain('**実**感');
    expect((await getWordDetail(db, '100%')).kakera.map((k) => k.id)).toEqual([C]);
    expect((await getWordDetail(db, '1_0%')).kakera).toEqual([]);
    expect((await getWordDetail(db, '%')).kakera).toEqual([]);
  });

  it('POST /api/words: 言葉は本文で受ける。空の言葉は 400。GET は索引だけ', async () => {
    const locals = { user: { email: 'test@example.com' }, runtime: { env: proxy.env } } as never;
    const post = (body: unknown) =>
      wordsPost({ locals, request: new Request('http://x/api/words', { method: 'POST', body: JSON.stringify(body) }) } as never) as Promise<Response>;
    const ok = await post({ word: '京都' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kakera: unknown[] }).kakera.length).toBeGreaterThan(0);
    expect((await post({ word: '' })).status).toBe(400);
    expect((await post({ word: '  ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const index = (await wordsGet({ locals, url: new URL('http://x/api/words?word=京都') } as never)) as Response;
    expect(Object.keys((await index.json()) as object)).toEqual(['words']);
  });

  it('括弧を外す・かけらを消すと減り、0 個で消える', async () => {
    await updateKakera(db, B, { body: '[[太郎]]と奈良。' });
    expect((await listWords(db)).map((w) => w.word)).not.toContain('奈良');
    const before = (await listWords(db)).find((w) => w.word === '京都')!.count;
    await deleteKakera(db, FLOW);
    const after = (await listWords(db)).find((w) => w.word === '京都')!;
    expect(after.count).toBe(before - 1);
    expect(after.last_written_at).toBe('2026-09-14T09:00:00+09:00');
  });
});
