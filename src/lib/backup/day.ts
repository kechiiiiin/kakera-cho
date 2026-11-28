// 控え（kakera-data）の1日のファイル: 気分と場所（かけら帳1日のページ設計「控えに気分と場所も書く」）。
//
//   day/2026-11-28.md   ← その日の気分と場所（D1 の今の中身で丸ごと書き直す・冪等）
//
// かたちのファイルと同じく、途中で失敗しても次の保存で追いつく。気分も場所も無くなった日はファイルを消す。
// 一覧から外した予定・写真（timeline_hidden）は見せ方なので載せない。

import { getDay, listPlacesOn, type Day, type Place } from '../kakera/day-db';
import { dataRepo } from './kakera-data';
import { deleteFile, putText, type RepoRef } from './github';

export function dayPath(date: string): string {
  return `day/${date}.md`;
}

/** 気分も場所も無ければ null（ファイルを持たない） */
export function renderDayFile(day: Day, places: Place[]): string | null {
  if (!day.mood && places.length === 0) return null;
  const lines = ['---', `date: ${day.date}`];
  if (day.mood) lines.push(`mood: ${JSON.stringify(day.mood)}`);
  if (places.length) {
    lines.push('places:');
    for (const p of places) {
      lines.push(`  - id: ${p.id}`);
      lines.push(`    at: ${p.at}`);
      lines.push(`    name: ${JSON.stringify(p.name)}`);
      if (p.lat !== null && p.lng !== null) {
        lines.push(`    lat: ${p.lat}`);
        lines.push(`    lng: ${p.lng}`);
      }
      lines.push(`    source: ${p.source}`);
    }
  }
  lines.push('---', '');
  // 人が読むための本文（時刻と場所の名前だけ）
  for (const p of places) lines.push(`- ${p.at.slice(11, 16)} ${p.name}`);
  if (places.length) lines.push('');
  return lines.join('\n');
}

/** 控えの読み書き口（テストで差し替える） */
export interface DayFileIo {
  putText: typeof putText;
  deleteFile: typeof deleteFile;
}

const githubIo: DayFileIo = { putText, deleteFile };

/** 1日ぶんの控えを書き直す（無くなったら消す） */
export async function backupDay(ref: RepoRef, day: Day, places: Place[], io: DayFileIo = githubIo): Promise<void> {
  const text = renderDayFile(day, places);
  if (text === null) await io.deleteFile(ref, dayPath(day.date), `delete(day): ${day.date}`);
  else await io.putText(ref, dayPath(day.date), text, `update(day): ${day.date}`);
}

/** D1 の今の中身で、その日（いくつかの日）の控えを書き直す。場所の日付を直したときは前後の両日を渡す */
export async function syncDays(env: Env, dates: string[]): Promise<void> {
  const ref = dataRepo(env);
  if (!ref) return;
  for (const date of [...new Set(dates)]) {
    const [day, places] = await Promise.all([getDay(env.DB, date), listPlacesOn(env.DB, date)]);
    await backupDay(ref, day, places);
  }
}
