// 日記になったかたちの日付を変える（公開中の日記ごと移す）テスト。
// ⚠️ 仮名だけで書く（このリポジトリは public。家族の実名を書かない）。
// D1 はローカルの miniflare（一時フォルダ）。astro-blog への読み書きは差し替えて、順番・中身・巻き戻しを確かめる。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import type { ExistingFile, FileChange } from '../backup/github';
import { ApiError } from '../http';
import { ulid } from '../ulid';
import { publishNikki, type BlogWriter } from './astro-blog';
import {
  REDIRECTS_PATH,
  diaryUrlPath,
  dropRedirectsFrom,
  moveCommitMessage,
  moveNikkiDate,
  planNikkiMove,
  rewritePubDate,
  updateRedirects,
  type BlogMover,
} from './nikki-move';
import { prepareNikkiExport } from './nikki-export';

const DIARY = (title: string, date: string) =>
  ['---', `title: "${title}"`, `pubDate: ${date}`, 'tags: []', 'draft: false', '---', '', '本文の行', '', 'pubDate: 本文の中は変えない', ''].join('\n');

describe('純粋な部品', () => {
  it('URL のパスは astro-blog と同じ形（末尾スラッシュ付き）', () => {
    expect(diaryUrlPath('2026-09-18')).toBe('/diary/2026/09/18/');
  });

  it('pubDate は frontmatter の中だけ差し替える', () => {
    const out = rewritePubDate(DIARY('ある日', '2026-09-18'), '2026-09-17')!;
    expect(out).toContain('pubDate: 2026-09-17\ntags');
    expect(out).toContain('pubDate: 本文の中は変えない');
    expect(out).not.toContain('2026-09-18');
    expect(rewritePubDate('本文だけ', '2026-09-17')).toBeNull();
    expect(rewritePubDate('---\ntitle: "x"\n---\n', '2026-09-17')).toBeNull();
  });

  it('転送: 新しく作る・付け替える・移し戻しで新しい URL を潰さない', () => {
    const first = updateRedirects(null, '2026-09-18', '2026-09-17');
    expect(first).toMatch(/^#/);
    expect(first).toContain('/diary/2026/09/18 /diary/2026/09/17/ 301\n');
    expect(first).toContain('/diary/2026/09/18/ /diary/2026/09/17/ 301\n');

    // 17 → 15: 18 の転送は 15 へ付け替える（連ねない）
    const second = updateRedirects(first, '2026-09-17', '2026-09-15');
    expect(second).toContain('/diary/2026/09/18/ /diary/2026/09/15/ 301');
    expect(second).toContain('/diary/2026/09/17/ /diary/2026/09/15/ 301');
    expect(second).not.toContain('/diary/2026/09/17/ 301');

    // 15 → 18: 18 から出ていく転送は消す。18 を指す行は自分自身になるので消える
    const back = updateRedirects(second, '2026-09-15', '2026-09-18');
    const rules = back.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(rules.some((l) => l.startsWith('/diary/2026/09/18'))).toBe(false);
    expect(rules).toContain('/diary/2026/09/17/ /diary/2026/09/18/ 301');
    expect(rules).toContain('/diary/2026/09/15/ /diary/2026/09/18/ 301');
  });

  it('転送: その日付を転送元にしている行だけを落とす（転送先としての行は残す）', () => {
    const text = [
      '# 見出し',
      '/diary/2026/09/18 /diary/2026/09/17/ 301',
      '/diary/2026/09/18/ /diary/2026/09/17/ 301',
      '/diary/2026/09/10 /diary/2026/09/18/ 301',
      '/diary/2026/09/10/ /diary/2026/09/18/ 301',
    ].join('\n');
    const out = dropRedirectsFrom(text, '2026-09-18')!;
    const rules = out.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(rules).toEqual(['/diary/2026/09/10 /diary/2026/09/18/ 301', '/diary/2026/09/10/ /diary/2026/09/18/ 301']);
    expect(dropRedirectsFrom(out, '2026-09-18')).toBeNull();
    expect(dropRedirectsFrom('# だけ\n', '2026-09-18')).toBeNull();
  });

  it('pubDate の書き換えは $ を含む frontmatter でも崩れない', () => {
    const text = ['---', 'title: "$& と $\' と $$"', 'pubDate: 2026-09-18', '---', '', '本文', ''].join('\n');
    const out = rewritePubDate(text, '2026-09-17')!;
    expect(out).toBe(text.replace('pubDate: 2026-09-18', 'pubDate: 2026-09-17'));
  });

  it('転送: 日記と関係ない行はそのまま残す', () => {
    const out = updateRedirects('# 手で書いた\n/old /new 302\n', '2026-09-18', '2026-09-17');
    expect(out.startsWith('# 手で書いた\n/old /new 302\n')).toBe(true);
  });

  it('移す変更: 旧を消す・新を足す・転送を書く（3つを1組で）', () => {
    const changes = planNikkiMove(
      { old: { sha: 'a', text: DIARY('ある日', '2026-09-18') }, next: null, redirects: null },
      '2026-09-18',
      '2026-09-17'
    );
    expect(changes.map((c) => [c.path, c.content === null])).toEqual([
      ['src/content/diary/2026-09-18.md', true],
      ['src/content/diary/2026-09-17.md', false],
      [REDIRECTS_PATH, false],
    ]);
  });

  it('移す変更: 公開側に旧が無い・移す先が既にある・pubDate が読めない なら 409', () => {
    const f = (old: ExistingFile | null, next: ExistingFile | null) => () =>
      planNikkiMove({ old, next, redirects: null }, '2026-09-18', '2026-09-17');
    expect(f(null, null)).toThrow(ApiError);
    expect(f({ sha: 'a', text: DIARY('x', '2026-09-18') }, { sha: 'b', text: 'y' })).toThrow(/既に astro-blog/);
    expect(f({ sha: 'a', text: '本文だけ' }, null)).toThrow(/pubDate/);
  });

  it('commit メッセージは move(diary): で始まり、移した元を残す', () => {
    const m = moveCommitMessage('2026-09-18', '2026-09-17', 'ある日');
    expect(m.split('\n')[0]).toBe('move(diary): 2026-09-18 → 2026-09-17 ある日');
    expect(m).toContain('Moved-From: src/content/diary/2026-09-18.md');
  });

  it('日記済みなのに公開側にファイルが無ければ書き出さない（X への再投稿を防ぐ）', async () => {
    const written: string[] = [];
    const gh = {
      fileExists: async () => false,
      readFile: async () => null,
      putText: async (_r: unknown, path: string) => {
        written.push(path);
      },
    } as unknown as BlogWriter;
    const env = { BLOG_GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', BLOG_REPO: 'r' } as Env;
    await expect(
      publishNikki(env, { date: '2026-09-18', title: 't', bodies: ['a'], alreadyPublished: true }, gh)
    ).rejects.toMatchObject({ status: 409 });
    expect(written).toEqual([]);
  });
});

/* ---------------- D1 と組み合わせて ---------------- */

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
let env: Env;

const K = ulid();
const OTHER = ulid();
const FROM = '2026-09-18';
const TO = '2026-09-17';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kakera-cho-move-'));
  const files = ['schema.sql', ...MIGRATIONS.map((m) => `migrations/${m}.sql`)];
  writeFileSync(join(dir, 'all.sql'), files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n'));
  execFileSync(
    join(root, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'kakera', '--local', '--persist-to', join(dir, 'state'), '--file', join(dir, 'all.sql')],
    { cwd: root, stdio: 'pipe' }
  );
  proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: join(dir, 'state', 'v3') } });
  env = { ...proxy.env, BLOG_GITHUB_TOKEN: 'test', GITHUB_OWNER: 'o', BLOG_REPO: 'r' } as Env;
}, 180000);

afterAll(async () => {
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const db = env.DB;
  const now = '2026-09-18T09:00:00+09:00';
  await db.batch([
    db.prepare('DELETE FROM nikki'),
    db.prepare('DELETE FROM katachi'),
    db.prepare('INSERT INTO katachi (id, date, title, updated_at) VALUES (?, ?, ?, ?)').bind(K, FROM, 'ある日', now),
    db.prepare('INSERT INTO nikki (katachi_id, slug, published_at, updated_at) VALUES (?, ?, ?, ?)').bind(K, FROM, now, now),
  ]);
});

async function dates(): Promise<{ date: string; slug: string }> {
  return (await env.DB
    .prepare('SELECT k.date AS date, n.slug AS slug FROM katachi k JOIN nikki n ON n.katachi_id = k.id WHERE k.id = ?')
    .bind(K)
    .first<{ date: string; slug: string }>())!;
}

/** astro-blog の差し替え。files は base 時点の中身。 */
function fakeBlog(files: Record<string, string>, opts: { failCommit?: boolean } = {}) {
  const commits: { base: string; changes: FileChange[]; message: string }[] = [];
  const mover: BlogMover = {
    headSha: async () => 'base-sha',
    readFileAt: async (_ref, path, sha) => {
      expect(sha).toBe('base-sha');
      return path in files ? { sha: 'x', text: files[path]! } : null;
    },
    commitChanges: async (_ref, base, changes, message) => {
      if (opts.failCommit) throw new Error('boom');
      commits.push({ base, changes, message });
      return 'new-sha';
    },
  };
  return { mover, commits };
}

describe('moveNikkiDate', () => {
  it('D1（かたちの日付・日記の slug）と astro-blog（1 commit）を揃えて移す', async () => {
    const { mover, commits } = fakeBlog({ [`src/content/diary/${FROM}.md`]: DIARY('ある日', FROM) });
    const r = await moveNikkiDate(env, K, TO, mover);
    expect(r).toEqual({ oldDate: FROM, commit: 'new-sha' });
    expect(await dates()).toEqual({ date: TO, slug: TO });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.base).toBe('base-sha');
    expect(commits[0]!.changes.map((c) => c.path)).toEqual([
      `src/content/diary/${FROM}.md`,
      `src/content/diary/${TO}.md`,
      REDIRECTS_PATH,
    ]);
    expect(commits[0]!.changes[1]!.content).toContain(`pubDate: ${TO}`);
    expect(commits[0]!.message.startsWith('move(diary):')).toBe(true);
  });

  it('astro-blog に書けなければ D1 を元に戻して 502', async () => {
    const { mover } = fakeBlog({ [`src/content/diary/${FROM}.md`]: DIARY('ある日', FROM) }, { failCommit: true });
    await expect(moveNikkiDate(env, K, TO, mover)).rejects.toMatchObject({ status: 502 });
    expect(await dates()).toEqual({ date: FROM, slug: FROM });
  });

  it('公開側に旧ファイルが無い（公開側で改名済み）なら何も書かずに 409', async () => {
    const { mover, commits } = fakeBlog({ [`src/content/diary/${TO}.md`]: DIARY('ある日', TO) });
    await expect(moveNikkiDate(env, K, TO, mover)).rejects.toMatchObject({ status: 409 });
    expect(commits).toHaveLength(0);
    expect(await dates()).toEqual({ date: FROM, slug: FROM });
  });

  it('移す先にかたちがあれば 409（1日1かたち）', async () => {
    await env.DB.prepare('INSERT INTO katachi (id, date, title, updated_at) VALUES (?, ?, ?, ?)')
      .bind(OTHER, TO, '', '2026-09-18T09:00:00+09:00')
      .run();
    const { mover, commits } = fakeBlog({ [`src/content/diary/${FROM}.md`]: DIARY('ある日', FROM) });
    await expect(moveNikkiDate(env, K, TO, mover)).rejects.toMatchObject({ status: 409 });
    expect(commits).toHaveLength(0);
  });

  it('かたちの日付と日記の slug が食い違っていたら、移すのも書き出すのも 409', async () => {
    await env.DB.prepare('UPDATE nikki SET slug = ? WHERE katachi_id = ?').bind('2026-09-10', K).run();
    const { mover, commits } = fakeBlog({ [`src/content/diary/${FROM}.md`]: DIARY('ある日', FROM) });
    await expect(moveNikkiDate(env, K, TO, mover)).rejects.toMatchObject({ status: 409 });
    expect(commits).toHaveLength(0);
    await expect(prepareNikkiExport(env.DB, K, {})).rejects.toMatchObject({ status: 409 });
  });
});

describe('書き出しと転送（Workers Static Assets は実ファイルより _redirects を優先する）', () => {
  function writer(redirects: string | null) {
    const puts: string[] = [];
    const commits: { changes: FileChange[]; message: string }[] = [];
    const gh: BlogWriter = {
      fileExists: async () => false,
      readFile: async () => null,
      putText: async (_r, path) => {
        puts.push(path);
      },
      headSha: async () => 'base-sha',
      readFileAt: async (_r, path, sha) => {
        expect(sha).toBe('base-sha');
        return path === REDIRECTS_PATH && redirects !== null ? { sha: 'r', text: redirects } : null;
      },
      commitChanges: async (_r, base, changes, message) => {
        expect(base).toBe('base-sha');
        commits.push({ changes, message });
        return 'new-sha';
      },
    };
    return { gh, puts, commits };
  }
  const input = { date: FROM, title: 'ある日', bodies: ['本文の行'], alreadyPublished: false };

  it('その日付を転送元にしている行があれば、.md と転送の削除を 1 commit にする', async () => {
    const { gh, puts, commits } = writer(updateRedirects(null, FROM, TO));
    await publishNikki(env, input, gh);
    expect(puts).toEqual([]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message.startsWith('create(diary): ある日')).toBe(true);
    expect(commits[0]!.changes.map((c) => c.path)).toEqual([`src/content/diary/${FROM}.md`, REDIRECTS_PATH]);
    expect(commits[0]!.changes[1]!.content).not.toContain('/diary/2026/09/18 ');
    expect(commits[0]!.changes[1]!.content).not.toContain('/diary/2026/09/18/ ');
  });

  it('転送が無ければ今までどおり .md だけを書く', async () => {
    const { gh, puts, commits } = writer(updateRedirects(null, '2026-09-01', '2026-09-02'));
    await publishNikki(env, input, gh);
    expect(puts).toEqual([`src/content/diary/${FROM}.md`]);
    expect(commits).toHaveLength(0);
  });

  it('転送を読めなければ何も書かずに止める', async () => {
    const { gh, puts, commits } = writer(null);
    gh.readFileAt = async () => {
      throw new Error('boom');
    };
    await expect(publishNikki(env, input, gh)).rejects.toMatchObject({ status: 502 });
    expect(puts).toEqual([]);
    expect(commits).toHaveLength(0);
  });
});
