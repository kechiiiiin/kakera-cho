// 1日のページ（気分・場所・一覧から外した印）の入力の検査（かけら帳1日のページ設計・段階1・2026-11-28）。
// iOS の DayView が叩く /api/day/:date・/api/place・/api/timeline-hidden の入口。zod で形を決め、違えば 400。

import { z } from 'zod';
import { ApiError } from '../http';
import { FUTURE_TOLERANCE_MS, isDateKey, isWrittenAt, normalizeToJst } from '../time';
import { isUlid } from '../ulid';

/** 気分のハンコ。並びは画面の並び（嬉・楽・穏・疲・哀） */
export const MOODS = ['嬉', '楽', '穏', '疲', '哀'] as const;
export type Mood = (typeof MOODS)[number];

export const PLACE_SOURCES = ['manual', 'visit'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

export const HIDDEN_KINDS = ['event', 'photo'] as const;
export type HiddenKind = (typeof HIDDEN_KINDS)[number];

export const PLACE_NAME_MAX = 200;
export const HIDDEN_REF_MAX = 512;

/** 'YYYY-MM-DD' で、暦にある日（2026-02-30 は通さない） */
export function isCalendarDate(s: unknown): s is string {
  if (!isDateKey(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const dateKey = z.string().refine(isCalendarDate, 'YYYY-MM-DD の日付で送ってください');

/** オフセット付きの ISO8601。+09:00（秒まで）に揃える。未来（数分のずれを超える）は拒否 */
function atSchema(nowMs: number) {
  return z
    .string()
    .refine(isWrittenAt, 'at はオフセット付きの ISO8601 で送ってください')
    .refine((s) => !Number.isNaN(new Date(s).getTime()), 'at が日時として読めません')
    .refine((s) => new Date(s).getTime() <= nowMs + FUTURE_TOLERANCE_MS, '未来の日時にはできません')
    .transform((s) => normalizeToJst(s));
}

const name = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, '場所の名前が空です')
  .refine((s) => s.length <= PLACE_NAME_MAX, `場所の名前は${PLACE_NAME_MAX}文字までです`);
const lat = z.number().finite().min(-90).max(90).nullable();
const lng = z.number().finite().min(-180).max(180).nullable();

/** zod の失敗を 400 の一文にする（どの欄か分かるように） */
function parseOr400<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new ApiError(400, `${where}${issue?.message ?? '形が違います'}`);
}

/** URL の :date */
export function parseDateParam(s: unknown): string {
  if (!isCalendarDate(s)) throw new ApiError(400, 'date は YYYY-MM-DD の日付で送ってください');
  return s;
}

/** PUT /api/day/:date — {mood: 嬉|楽|穏|疲|哀|null}（null で外す） */
export function parseDayPut(input: unknown): { mood: Mood | null } {
  return parseOr400(z.object({ mood: z.enum(MOODS).nullable() }), input);
}

export interface PlaceCreate {
  id: string;
  at: string;
  name: string;
  lat: number | null;
  lng: number | null;
  source: PlaceSource;
}

/** POST /api/place — {id(ULID), at, name, lat?, lng?, source?}。座標は両方そろえるか、両方無し */
export function parsePlaceCreate(input: unknown, nowMs: number = Date.now()): PlaceCreate {
  const schema = z
    .object({
      id: z.string().refine(isUlid, 'id は ULID で送ってください'),
      at: atSchema(nowMs),
      name,
      lat: lat.optional(),
      lng: lng.optional(),
      source: z.enum(PLACE_SOURCES).optional(),
    })
    .refine((p) => (p.lat == null) === (p.lng == null), { message: '座標は lat と lng をそろえて送ってください', path: ['lat'] })
    .transform((p) => ({ id: p.id, at: p.at, name: p.name, lat: p.lat ?? null, lng: p.lng ?? null, source: p.source ?? 'manual' }));
  return parseOr400(schema, input);
}

export interface PlacePatch {
  at?: string;
  name?: string;
  /** 座標を直すときは lat / lng を必ずそろえて（null で座標を外す） */
  lat?: number | null;
  lng?: number | null;
}

/** PATCH /api/place/:id — at・name・座標（lat と lng の組）のどれか */
export function parsePlacePatch(input: unknown, nowMs: number = Date.now()): PlacePatch {
  const schema = z
    .object({ at: atSchema(nowMs).optional(), name: name.optional(), lat: lat.optional(), lng: lng.optional() })
    .refine((p) => (p.lat === undefined) === (p.lng === undefined) && (p.lat === null) === (p.lng === null), {
      message: '座標は lat と lng をそろえて送ってください',
      path: ['lat'],
    })
    .refine((p) => p.at !== undefined || p.name !== undefined || p.lat !== undefined, {
      message: 'at・name・座標のどれかを送ってください',
    });
  const p = parseOr400(schema, input);
  const out: PlacePatch = {};
  if (p.at !== undefined) out.at = p.at;
  if (p.name !== undefined) out.name = p.name;
  if (p.lat !== undefined) {
    out.lat = p.lat;
    out.lng = p.lng ?? null;
  }
  return out;
}

export interface HiddenKey {
  kind: HiddenKind;
  ref: string;
}

const hiddenKey = {
  kind: z.enum(HIDDEN_KINDS),
  ref: z.string().min(1, 'ref が空です').max(HIDDEN_REF_MAX, `ref は${HIDDEN_REF_MAX}文字までです`),
};

/** POST /api/timeline-hidden — {kind: event|photo, ref, date} */
export function parseHiddenCreate(input: unknown): HiddenKey & { date: string } {
  return parseOr400(z.object({ ...hiddenKey, date: dateKey }), input);
}

/** DELETE /api/timeline-hidden?kind=&ref= （写真の ref は / を含むので、パスではなく問い合わせで受ける） */
export function parseHiddenKey(input: unknown): HiddenKey {
  return parseOr400(z.object(hiddenKey), input);
}
