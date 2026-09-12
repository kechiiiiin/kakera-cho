// JST 固定の時刻まわり。
// ⚠️ written_at は必ず +09:00 付きで保存する（設計 §4）。
// オフセットが揺れると控えのファイル名の DD_hhmm がずれ、削除時にどのファイルを消すか分からなくなる。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 今この瞬間の JST を ISO8601（+09:00 付き）で返す。 */
export function nowJst(): string {
  return toJstIso(new Date());
}

/** Date を JST の ISO8601（+09:00 付き・秒まで）にする。 */
export function toJstIso(d: Date): string {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return (
    j.getUTCFullYear() +
    '-' + pad(j.getUTCMonth() + 1) +
    '-' + pad(j.getUTCDate()) +
    'T' + pad(j.getUTCHours()) +
    ':' + pad(j.getUTCMinutes()) +
    ':' + pad(j.getUTCSeconds()) +
    '+09:00'
  );
}

/** 今日の JST 日付 'YYYY-MM-DD'。 */
export function todayJst(): string {
  return nowJst().slice(0, 10);
}

/**
 * written_at 文字列から控えのファイル名の部品を取り出す。
 * 文字列をそのまま切る（Date に通すとローカル時計のオフセットが混ざる）。
 */
export function partsOfWrittenAt(writtenAt: string): {
  year: string;
  month: string;
  day: string;
  hhmm: string;
} {
  return {
    year: writtenAt.slice(0, 4),
    month: writtenAt.slice(5, 7),
    day: writtenAt.slice(8, 10),
    hhmm: writtenAt.slice(11, 13) + writtenAt.slice(14, 16),
  };
}

/** 'YYYY-MM-DD' として妥当か。 */
export function isDateKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * written_at として受け取れる形か（必ずオフセット付き）。
 * オフセット無しの素の ISO は受けない——ここが緩むとファイル名がずれる。
 */
export function isWrittenAt(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/.test(s);
}

/** どんなオフセットで来ても +09:00 表記に正規化する（秒まで揃える）。 */
export function normalizeToJst(iso: string): string {
  return toJstIso(new Date(iso));
}
