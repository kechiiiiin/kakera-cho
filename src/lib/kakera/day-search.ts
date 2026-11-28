// 1日のページの段階5（かけら帳1日のページ設計）: 月カレンダーの日ごとの数・日付つきの検索・全期間の書き出し。
// iOS の1日のページ（ios/App/Tsuki.swift・DaySearch.swift・SettingsView.swift）が叩く。既存の口（/api/search の results など）は変えない。
//
// ★書き出しは全期間（本番で 300 件ほど）なので、表ごとに1回ずつ読む（日ごとに引かない＝N+1 にしない）。

import { buildExcerpt } from '../markdown';
import { MIN_TRIGRAM_LEN, charLength, escapeFtsPhrase, escapeLikePattern } from './db';
import type { Mood } from './day-input';

/* ---------------- 月カレンダー ---------------- */

export interface DaySummary {
  /** 'YYYY-MM-DD'（JST） */
  date: string;
  kakera: number;
  places: number;
  mood: Mood | null;
}

/** 'YYYY-MM' として妥当か（01〜12） */
export function isMonthKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** 次の月 'YYYY-MM' */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** その月の、かけら・場所・気分のどれかがある日（日付順）。written_at / at は +09:00 なので先頭10文字が JST の日 */
export async function monthDays(db: D1Database, month: string): Promise<DaySummary[]> {
  const from = `${month}-01`;
  const to = `${nextMonth(month)}-01`;
  const [k, p, d] = await db.batch([
    db
      .prepare('SELECT substr(written_at, 1, 10) AS date, count(*) AS n FROM kakera WHERE written_at >= ? AND written_at < ? GROUP BY 1')
      .bind(from, to),
    db.prepare('SELECT substr(at, 1, 10) AS date, count(*) AS n FROM place WHERE at >= ? AND at < ? GROUP BY 1').bind(from, to),
    db.prepare('SELECT date, mood FROM day WHERE date >= ? AND date < ? AND mood IS NOT NULL').bind(from, to),
  ]);
  const byDate = new Map<string, DaySummary>();
  const get = (date: string) => {
    let s = byDate.get(date);
    if (!s) byDate.set(date, (s = { date, kakera: 0, places: 0, mood: null }));
    return s;
  };
  for (const r of (k!.results ?? []) as { date: string; n: number }[]) get(r.date).kakera = r.n;
  for (const r of (p!.results ?? []) as { date: string; n: number }[]) get(r.date).places = r.n;
  for (const r of (d!.results ?? []) as { date: string; mood: Mood }[]) get(r.date).mood = r.mood;
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------- 日付つきの検索（かけら全部＋場所名） ---------------- */

export interface KakeraHit {
  id: string;
  written_at: string;
  excerpt: string;
}

export interface PlaceHit {
  id: string;
  at: string;
  name: string;
}

/** 一度に返す上限（新しい順に切る） */
export const DAY_SEARCH_LIMIT = 200;

/**
 * かけら（かたちの中も流れも全部）の本文と、場所の名前を引く。どちらも新しい順。
 * かたちの検索（searchKatachi）と同じく、3文字以上は trigram の FTS、それ未満は LIKE。
 */
export async function searchDays(db: D1Database, rawQuery: string): Promise<{ kakera: KakeraHit[]; places: PlaceHit[] }> {
  const q = rawQuery.trim();
  if (!q) return { kakera: [], places: [] };
  const like = '%' + escapeLikePattern(q) + '%';
  const kakeraStmt =
    charLength(q) < MIN_TRIGRAM_LEN
      ? db
          .prepare(`SELECT id, written_at, body FROM kakera WHERE body LIKE ? ESCAPE '\\' ORDER BY written_at DESC LIMIT ?`)
          .bind(like, DAY_SEARCH_LIMIT)
      : db
          .prepare(
            `SELECT k.id, k.written_at, k.body FROM kakera_fts JOIN kakera k ON k.id = kakera_fts.kakera_id
              WHERE kakera_fts MATCH ? ORDER BY k.written_at DESC LIMIT ?`
          )
          .bind(escapeFtsPhrase(q), DAY_SEARCH_LIMIT);
  const placeStmt = db
    .prepare(`SELECT id, at, name FROM place WHERE name LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?`)
    .bind(like, DAY_SEARCH_LIMIT);
  const [k, p] = await db.batch([kakeraStmt, placeStmt]);
  return {
    kakera: ((k!.results ?? []) as { id: string; written_at: string; body: string }[]).map((r) => ({
      id: r.id,
      written_at: r.written_at,
      excerpt: buildExcerpt(r.body, q),
    })),
    places: (p!.results ?? []) as PlaceHit[],
  };
}

/* ---------------- 全期間の書き出し ---------------- */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

export interface ExportRows {
  kakera: { written_at: string; body: string }[];
  places: { at: string; name: string }[];
  moods: { date: string; mood: string }[];
}

/** 表ごとに1回ずつ読む（日付順） */
export async function exportRows(db: D1Database): Promise<ExportRows> {
  const [k, p, d] = await db.batch([
    db.prepare('SELECT written_at, body FROM kakera ORDER BY written_at, id'),
    db.prepare('SELECT at, name FROM place ORDER BY at, id'),
    db.prepare('SELECT date, mood FROM day WHERE mood IS NOT NULL ORDER BY date'),
  ]);
  return {
    kakera: (k!.results ?? []) as ExportRows['kakera'],
    places: (p!.results ?? []) as ExportRows['places'],
    moods: (d!.results ?? []) as ExportRows['moods'],
  };
}

/**
 * 日ごとのテキスト（日付順）。日ごとに 日付・気分・場所（時刻・名前）・かけら（時刻・本文）。
 * 予定と写真は端末にしか無いので入らない。かけらの本文は各行を2字下げて、日の区切りと混ざらないようにする。
 */
export function renderExport(rows: ExportRows, generatedAt: string): string {
  const dates = new Set<string>();
  const kakeraBy = new Map<string, ExportRows['kakera']>();
  const placesBy = new Map<string, ExportRows['places']>();
  const moodBy = new Map<string, string>();
  for (const r of rows.kakera) {
    const d = r.written_at.slice(0, 10);
    dates.add(d);
    (kakeraBy.get(d) ?? kakeraBy.set(d, []).get(d)!).push(r);
  }
  for (const r of rows.places) {
    const d = r.at.slice(0, 10);
    dates.add(d);
    (placesBy.get(d) ?? placesBy.set(d, []).get(d)!).push(r);
  }
  for (const r of rows.moods) {
    dates.add(r.date);
    moodBy.set(r.date, r.mood);
  }
  const out: string[] = [
    'かけら帳 書き出し（全期間）',
    `書き出した日時: ${generatedAt.slice(0, 16).replace('T', ' ')}`,
    `日数: ${dates.size}　かけら: ${rows.kakera.length}　場所: ${rows.places.length}`,
    '予定と写真は端末にしか無いので入っていません。',
    '',
  ];
  for (const date of [...dates].sort()) {
    out.push(`==== ${date}（${weekday(date)}） ====`);
    const mood = moodBy.get(date);
    if (mood) out.push(`気分: ${mood}`);
    const places = placesBy.get(date) ?? [];
    if (places.length) {
      out.push('場所:');
      for (const p of places) out.push(`  ${p.at.slice(11, 16)}  ${p.name}`);
    }
    const kakera = kakeraBy.get(date) ?? [];
    if (kakera.length) {
      out.push('かけら:');
      for (const k of kakera) {
        out.push(`  [${k.written_at.slice(11, 16)}]`);
        for (const line of k.body.split('\n')) out.push(line ? `    ${line}` : '');
      }
    }
    out.push('');
  }
  return out.join('\n');
}
