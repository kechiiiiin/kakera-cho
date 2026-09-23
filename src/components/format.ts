// 日付・時刻の見せ方。書く側は機械的に、読む側は文語で組む。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function weekdayOf(dateKey: string): string {
  return WEEKDAYS[new Date(dateKey + 'T00:00:00').getDay()]!;
}

/** written_at から 'YYYY-MM-DD' */
export function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

/** written_at から 'HH:MM' */
export function timeOf(iso: string): string {
  return iso.slice(11, 16);
}

/** 流れの日ごとの小見出し（例: 09-12 (土)） */
export function dayGroupHeading(dateKey: string): string {
  return dateKey.slice(5) + ' (' + weekdayOf(dateKey) + ')';
}

/** 書く側の日付（例: 2026-09-12 (土)） */
export function dateHeading(dateKey: string): string {
  return dateKey + ' (' + weekdayOf(dateKey) + ')';
}

/** 読む側の日付（例: 2026年9月12日（土）） */
export function dateLiterary(dateKey: string): string {
  const d = new Date(dateKey + 'T00:00:00');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${weekdayOf(dateKey)}）`;
}

/** 月の見出し（例: 2026年9月） */
export function monthHeading(monthKey: string): string {
  const [y, m] = monthKey.split('-');
  return `${y}年${parseInt(m!, 10)}月`;
}

/**
 * 本文の高さまで textarea を伸ばす。
 *
 * ⚠️ 縮んだぶんを測るために一度 auto へ戻すが、その瞬間だけ文書が短くなる。長いかけらを
 * 開いていると、ブラウザがそこでスクロール位置を切り詰めてしまい、高さを戻しても位置は
 * 戻らない——iOS で一文字打つたびに画面が一番上へ飛んでいた（2026-09-23）。
 * 縮める前の位置を控えて、同じフレームのうちに戻す。
 */
export function autoGrow(ta: HTMLTextAreaElement | null): void {
  if (!ta) return;
  const scroller = document.scrollingElement ?? document.documentElement;
  const keep = scroller.scrollTop;
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight, 70) + 'px';
  if (scroller.scrollTop !== keep) scroller.scrollTop = keep;
}
