// かけらごとに出す時刻（かけら時刻表示設計・2026-10-12）。
// かたちの読む画面・変換ページ・書き出しの三か所で同じ規則を使うので、DOM にも Workers にも依存しないここに置く。
//
// 規則:
//  - かたちの日付と同じ日に書いたかけらは「HH:MM」
//  - 違う日のかけらだけ、日付を添えて「MM-DD HH:MM」（例: 10-10 のかたちで翌日の 03:20 は「10-11 03:20」）
//  - 年まで違うときは「YYYY-MM-DD HH:MM」（MM-DD だけでは別の年と読めないため）
// ★written_at は +09:00 付き（JST）で保存されている。文字列をそのまま切る（Date に通すと端末の時差が混ざる）。

/** 時刻の文字（かたちの日付 katachiDate は 'YYYY-MM-DD'）。 */
export function kakeraTimeLabel(writtenAt: string, katachiDate: string): string {
  const day = writtenAt.slice(0, 10);
  const hhmm = writtenAt.slice(11, 16);
  if (day === katachiDate) return hhmm;
  if (day.slice(0, 4) !== katachiDate.slice(0, 4)) return `${day} ${hhmm}`;
  return `${day.slice(5)} ${hhmm}`;
}

/** 日記・画面にかけらの上に出す時刻（出さないかけらは null）。 */
export interface KakeraTimeHead {
  /** 見せる文字（kakeraTimeLabel） */
  label: string;
  /** 機械向けの日時（written_at そのまま・+09:00 付き）。日記では <time datetime> に入る */
  datetime: string;
}

export function timeHeadOf(
  k: { written_at: string; show_time?: boolean },
  katachiDate: string
): KakeraTimeHead | null {
  if (!k.show_time) return null;
  return { label: kakeraTimeLabel(k.written_at, katachiDate), datetime: k.written_at };
}
