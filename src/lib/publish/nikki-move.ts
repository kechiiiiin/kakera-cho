// 日記になったかたちの日付を変える（公開中の日記の日付と URL も一緒に移す）。
//
// astro-blog では「旧 .md を消す・新 .md を足す・転送（public/_redirects）を書く」を**1つの commit**にする。
// ⚠️ X 自動投稿（astro-blog の scripts/post-diary-to-x.mjs）は「追加された日記」を投稿する。
//   足すだけの commit が先にデプロイされると、移しただけの日記が X に再投稿される（1件ごとに課金・重複）。
//   1 commit にすれば「足しただけ」の状態がブランチに現れない。投稿側でも「同じ commit で既存の日記を
//   消している追加」は移動として投稿しない（二重の守り）。
//
// 本文は組み直さない。公開中の .md をそのまま使い、frontmatter の pubDate だけを書き換える
// （画面で確かめていない文を、日付を変えるついでに出さない）。
//
// 順序（fail-closed）:
//  1. D1 と astro-blog の前提を読んで確かめる（食い違い・移す先の重なりは何も書かずに 409）
//  2. D1 の katachi.date と nikki.slug を一度に変える
//  3. astro-blog へ 1 commit。失敗したら 2 を元に戻す（どちらも元のまま＝やり直せる）

import { ApiError } from '../http';
import { nowJst } from '../time';
import {
  commitChanges,
  headSha,
  readFileAt,
  type ExistingFile,
  type FileChange,
  type RepoRef,
} from '../backup/github';
import { getKatachiRow, getNikkiRow } from '../kakera/db';
import { blogRepo, diaryPath } from './astro-blog';

export const REDIRECTS_PATH = 'public/_redirects';

/** 日記の公開 URL のパス（astro-blog の getDiaryPath と同じ形・末尾スラッシュ付き）。 */
export function diaryUrlPath(date: string): string {
  const [y, m, d] = date.split('-');
  return `/diary/${y}/${m}/${d}/`;
}

/** frontmatter の pubDate だけを差し替える。frontmatter か pubDate が無ければ null。 */
export function rewritePubDate(text: string, date: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fm = m[1]!;
  if (!/^pubDate:.*$/m.test(fm)) return null;
  const next = fm.replace(/^pubDate:.*$/m, `pubDate: ${date}`);
  return text.slice(0, m.index) + m[0].replace(fm, next) + text.slice(m.index + m[0].length);
}

const REDIRECTS_HEADER = [
  '# 日記の日付を変えたときの転送（旧 URL → 新 URL）。かけら帳が日付を変えるたびに書き足す。',
  '# Workers Static Assets の _redirects。https://developers.cloudflare.com/workers/static-assets/redirects/',
];

function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * _redirects に「from の日記 → to の日記」を足す。
 * - 移す先（to）から出ていく転送は消す（移し戻したときに新しい URL が転送で潰れないように）
 * - 今まで from を指していた転送は to へ付け替える（転送を連ねない）
 * - 転送元と転送先が同じになった行は消す
 * - 末尾スラッシュの有無の両方を載せる
 * 他の行（日記と関係ない転送・コメント）はそのまま残す。
 */
export function updateRedirects(text: string | null, fromDate: string, toDate: string): string {
  const from = diaryUrlPath(fromDate);
  const to = diaryUrlPath(toDate);
  const lines = text === null ? [...REDIRECTS_HEADER] : text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      out.push(line);
      continue;
    }
    const [src, dst, ...rest] = t.split(/\s+/);
    if (!src || !dst) {
      out.push(line);
      continue;
    }
    if (stripSlash(src) === stripSlash(to) || stripSlash(src) === stripSlash(from)) continue;
    const nextDst = stripSlash(dst) === stripSlash(from) ? to : dst;
    if (stripSlash(src) === stripSlash(nextDst)) continue;
    out.push(nextDst === dst ? line : [src, nextDst, ...rest].join(' '));
  }
  out.push(`${stripSlash(from)} ${to} 301`, `${from} ${to} 301`);
  return out.join('\n') + '\n';
}

export interface MoveFiles {
  /** 公開中の日記（旧日付） */
  old: ExistingFile | null;
  /** 移す先に既にある日記 */
  next: ExistingFile | null;
  redirects: ExistingFile | null;
}

/** astro-blog に書く変更を組む。前提が崩れていれば 409（何も書かない）。 */
export function planNikkiMove(files: MoveFiles, fromDate: string, toDate: string): FileChange[] {
  if (!files.old) {
    throw new ApiError(
      409,
      `公開中の日記（${fromDate}）が astro-blog に見当たりません。かけら帳と公開側が食い違っているので、日付は変えていません。`
    );
  }
  if (files.next) {
    throw new ApiError(409, `${toDate} の日記は既に astro-blog にあります。上書きしないよう、日付は変えていません。`);
  }
  const moved = rewritePubDate(files.old.text, toDate);
  if (moved === null) {
    throw new ApiError(409, `公開中の日記（${fromDate}）の frontmatter に pubDate が読めません。日付は変えていません。`);
  }
  return [
    { path: diaryPath(fromDate), content: null },
    { path: diaryPath(toDate), content: moved },
    { path: REDIRECTS_PATH, content: updateRedirects(files.redirects?.text ?? null, fromDate, toDate) },
  ];
}

/** astro-blog への読み書き（差し替えて順番と巻き戻しを確かめられるように）。 */
export interface BlogMover {
  headSha: typeof headSha;
  readFileAt: typeof readFileAt;
  commitChanges: typeof commitChanges;
}

const githubMover: BlogMover = { headSha, readFileAt, commitChanges };

export function moveCommitMessage(fromDate: string, toDate: string, title: string): string {
  return [
    `move(diary): ${fromDate} → ${toDate} ${title}`.trim(),
    '',
    '日記の日付を変えた（かけら帳）。旧 URL は public/_redirects で新しい URL へ転送する。',
    '同じ commit で旧ファイルを消しているので、X には投稿しない（移動であって新しい日記ではない）。',
    '',
    `Moved-From: ${diaryPath(fromDate)}`,
  ].join('\n');
}

async function setDates(db: D1Database, id: string, from: string, to: string): Promise<void> {
  const now = nowJst();
  const [k, n] = await db.batch([
    db.prepare('UPDATE katachi SET date = ?, updated_at = ? WHERE id = ? AND date = ?').bind(to, now, id, from),
    db.prepare('UPDATE nikki SET slug = ?, updated_at = ? WHERE katachi_id = ? AND slug = ?').bind(to, now, id, from),
  ]);
  if ((k?.meta?.changes ?? 0) !== 1 || (n?.meta?.changes ?? 0) !== 1) {
    throw new Error(`日付の書き換えが揃いませんでした（katachi ${k?.meta?.changes ?? 0}・nikki ${n?.meta?.changes ?? 0}）`);
  }
}

/**
 * 日記になったかたちの日付を変える。成功したら旧日付を返す。
 * 失敗したら ApiError（D1 も astro-blog も元のまま）。巻き戻しにも失敗したときだけ、食い違いをそのまま伝える。
 */
export async function moveNikkiDate(
  env: Env,
  id: string,
  toDate: string,
  mover: BlogMover = githubMover
): Promise<{ oldDate: string; commit: string }> {
  const db = env.DB;
  const before = await getKatachiRow(db, id);
  if (!before) throw new ApiError(404, 'そのかたちはありません');
  const fromDate = before.date;
  if (fromDate === toDate) throw new ApiError(400, '日付が変わっていません');
  const nikki = await getNikkiRow(db, id);
  if (!nikki) throw new ApiError(409, 'このかたちはまだ日記になっていません');
  if (nikki.slug !== fromDate) {
    throw new ApiError(
      409,
      `かたちの日付（${fromDate}）と公開中の日記の日付（${nikki.slug}）が食い違っています。日付は変えていません。`
    );
  }
  const dup = await db.prepare('SELECT id FROM katachi WHERE date = ? AND id != ?').bind(toDate, id).first<{ id: string }>();
  if (dup) throw new ApiError(409, `${toDate} のかたちはもうあります（1日にひとつです）`);

  // 1. 公開側の前提（同じ commit 時点で読む）
  const ref: RepoRef = blogRepo(env);
  let base: string;
  let changes: FileChange[];
  try {
    base = await mover.headSha(ref);
    const [old, next, redirects] = await Promise.all([
      mover.readFileAt(ref, diaryPath(fromDate), base),
      mover.readFileAt(ref, diaryPath(toDate), base),
      mover.readFileAt(ref, REDIRECTS_PATH, base),
    ]);
    changes = planNikkiMove({ old, next, redirects }, fromDate, toDate);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error('[nikki-move] read', e instanceof Error ? e.message : e);
    throw new ApiError(502, 'astro-blog を読めませんでした。日付は変えていません。少し置いてからもう一度どうぞ。');
  }

  // 2. D1
  try {
    await setDates(db, id, fromDate, toDate);
  } catch (e) {
    console.error('[nikki-move] d1', e instanceof Error ? e.message : e);
    try {
      await restoreDates(db, id, fromDate, toDate);
    } catch {
      throw new ApiError(500, `かたちの日付の書き換えが途中で止まりました。開き直して日付が ${fromDate} のままか確かめてください（公開側は変えていません）。`);
    }
    throw new ApiError(409,`日付を書き換えられませんでした（${toDate} が他と重なっていないか確かめてください）。日付は変えていません。`);
  }

  // 3. astro-blog（1 commit）。失敗したら D1 を戻す
  try {
    const commit = await mover.commitChanges(ref, base, changes, moveCommitMessage(fromDate, toDate, before.title));
    return { oldDate: fromDate, commit };
  } catch (e) {
    console.error('[nikki-move] commit', e instanceof Error ? e.message : e);
    try {
      await restoreDates(db, id, fromDate, toDate);
    } catch (e2) {
      console.error('[nikki-move] restore', e2 instanceof Error ? e2.message : e2);
      throw new ApiError(
        500,
        `astro-blog に書けず、かたちの日付も ${fromDate} に戻せませんでした。今は かけら帳=${toDate}・公開側=${fromDate} です。「日記に書き足す」はせず、日付を ${fromDate} に戻してください。`
      );
    }
    throw new ApiError(502, 'astro-blog に書けませんでした。かたちの日付も元に戻しました。少し置いてからもう一度どうぞ。');
  }
}

/** 2 を元に戻す（to のままのものだけ）。 */
async function restoreDates(db: D1Database, id: string, fromDate: string, toDate: string): Promise<void> {
  const now = nowJst();
  await db.batch([
    db.prepare('UPDATE katachi SET date = ?, updated_at = ? WHERE id = ? AND date = ?').bind(fromDate, now, id, toDate),
    db.prepare('UPDATE nikki SET slug = ?, updated_at = ? WHERE katachi_id = ? AND slug = ?').bind(fromDate, now, id, toDate),
  ]);
  const k = await getKatachiRow(db, id);
  const n = await getNikkiRow(db, id);
  if (k?.date !== fromDate || n?.slug !== fromDate) throw new Error('日付を戻せませんでした');
}
