// D1 への問い合わせ。ここがドメインの処理の入口で、API ルートは薄い殻にする（iOS から同じ API を使うため）。

import type { Kakera, Katachi, KatachiDetail, KatachiSummary, Nikki, SearchMatch, SearchResult } from './types';
import type { LinkCard, LinkCards } from '../card/types';
import { buildExcerpt, textForExcerpt } from '../markdown';
import { domainOf, parseCardUrls } from '../card/url';
import { isSafePhotoKey, photoUrlFor } from '../publish/photos';
import { nowJst } from '../time';
import { ApiError } from '../http';

// 置き場所（どのかたちの何番目か）は katachi_kakera だけが持つ（migrations/0004）。
// kakera の行は「中身」だけ。★置き場所の操作で kakera の行（updated_at）に触らないこと——
// 公開名変換の選択は kakera.updated_at を basis にしているので、触ると本文を直していないのに白紙に戻る。
//
// 画面と控えの形（Kakera.katachi_id / sort_order）は変えず、ここで LEFT JOIN して導出する。

/** かけら＋置き場所。別名は k（kakera）と kk（katachi_kakera）。 */
const KAKERA_SELECT = `SELECT k.id, k.body, k.written_at, kk.katachi_id, kk.sort_order, k.updated_at
  FROM kakera k LEFT JOIN katachi_kakera kk ON kk.kakera_id = k.id`;

/** かけらの流れ（まだかたちになっていないもの＝置き場所の行が無いものだけ・新しい順）。 */
export async function listNagare(db: D1Database): Promise<Kakera[]> {
  const { results } = await db
    .prepare(
      `SELECT k.id, k.body, k.written_at, NULL AS katachi_id, NULL AS sort_order, k.updated_at
         FROM kakera k
        WHERE NOT EXISTS (SELECT 1 FROM katachi_kakera kk WHERE kk.kakera_id = k.id)
        ORDER BY k.written_at DESC`
    )
    .all<Kakera>();
  return results ?? [];
}

export async function getKakera(db: D1Database, id: string): Promise<Kakera | null> {
  return await db.prepare(`${KAKERA_SELECT} WHERE k.id = ?`).bind(id).first<Kakera>();
}

export async function insertKakera(
  db: D1Database,
  k: { id: string; body: string; written_at: string }
): Promise<Kakera> {
  const now = nowJst();
  const existing = await db.prepare('SELECT id FROM kakera WHERE id = ?').bind(k.id).first<{ id: string }>();
  if (existing) throw new ApiError(409, 'その id のかけらはもうあります');
  await db
    .prepare('INSERT INTO kakera (id, body, written_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(k.id, k.body, k.written_at, now)
    .run();
  return { ...k, katachi_id: null, sort_order: null, updated_at: now };
}

/** 本文だけを直す。written_at は不変なので絶対に触らない。kakera.updated_at を進めるのはここだけ。 */
export async function updateKakeraBody(db: D1Database, id: string, body: string): Promise<Kakera> {
  const now = nowJst();
  const res = await db
    .prepare('UPDATE kakera SET body = ?, updated_at = ? WHERE id = ?')
    .bind(body, now, id)
    .run();
  if (!res.meta.changes) throw new ApiError(404, 'そのかけらはありません');
  const k = await getKakera(db, id);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  return k;
}

/**
 * かけらを物理削除する。置き場所の行は ON DELETE CASCADE で消える。
 * ★nikki_kakera は消さない（書き出したときの記録。astro-blog にはその文章がまだ載っている）。
 */
export async function deleteKakera(db: D1Database, id: string): Promise<Kakera> {
  const k = await getKakera(db, id);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  await db.prepare('DELETE FROM kakera WHERE id = ?').bind(id).run();
  return k;
}

/* ---------------- かたち ---------------- */

export async function listKatachi(db: D1Database): Promise<KatachiSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT k.*,
              (SELECT 1 FROM nikki n WHERE n.katachi_id = k.id) AS has_nikki,
              (SELECT f.body FROM katachi_kakera kk JOIN kakera f ON f.id = kk.kakera_id
                WHERE kk.katachi_id = k.id ORDER BY kk.sort_order LIMIT 1) AS lead_body
         FROM katachi k
        ORDER BY k.date DESC`
    )
    .all<Katachi & { has_nikki: number | null; lead_body: string | null }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    date: r.date,
    title: r.title,
    updated_at: r.updated_at,
    has_nikki: !!r.has_nikki,
    lead: textForExcerpt(r.lead_body ?? ''),
  }));
}

// 三つ目のタブ（日記）は has_nikki で絞れるので、専用の取得は作らない。

export async function getKatachiRow(db: D1Database, id: string): Promise<Katachi | null> {
  return await db.prepare('SELECT * FROM katachi WHERE id = ?').bind(id).first<Katachi>();
}

export async function getNikkiRow(db: D1Database, katachiId: string): Promise<Nikki | null> {
  return await db.prepare('SELECT * FROM nikki WHERE katachi_id = ?').bind(katachiId).first<Nikki>();
}

/** かたちの中のかけら（並び順）。 */
export async function kakeraOfKatachi(db: D1Database, katachiId: string): Promise<Kakera[]> {
  const { results } = await db
    .prepare(
      `SELECT k.id, k.body, k.written_at, kk.katachi_id, kk.sort_order, k.updated_at
         FROM katachi_kakera kk JOIN kakera k ON k.id = kk.kakera_id
        WHERE kk.katachi_id = ?
        ORDER BY kk.sort_order`
    )
    .bind(katachiId)
    .all<Kakera>();
  return results ?? [];
}

export async function getKatachiDetail(db: D1Database, id: string): Promise<KatachiDetail> {
  const katachi = await getKatachiRow(db, id);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const [kakera, nikki, published] = await Promise.all([
    kakeraOfKatachi(db, id),
    getNikkiRow(db, id),
    db
      .prepare('SELECT kakera_id FROM nikki_kakera WHERE katachi_id = ? ORDER BY position')
      .bind(id)
      .all<{ kakera_id: string }>(),
  ]);
  return {
    katachi,
    kakera,
    nikki,
    // 書き出したときの記録そのまま。今このかたちにいない・もう無いかけらの id も混ざりうる
    published_ids: (published.results ?? []).map((r) => r.kakera_id),
  };
}

/** かたちを作る。1日1かたちなので、同じ日付が既にあれば 409。 */
export async function createKatachi(
  db: D1Database,
  input: { id: string; date: string; title: string; kakera_ids: string[] }
): Promise<KatachiDetail> {
  const now = nowJst();
  const dup = await db.prepare('SELECT id FROM katachi WHERE date = ?').bind(input.date).first<{ id: string }>();
  if (dup) throw new ApiError(409, `${input.date} のかたちはもうあります（1日にひとつです）`);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO katachi (id, date, title, updated_at) VALUES (?, ?, ?, ?)')
      .bind(input.id, input.date, input.title, now),
  ];
  input.kakera_ids.forEach((kid, i) => {
    // 流れにいるものだけを取り込む（二重取り込みの防止）。無い id・他のかたちにいる id は黙って飛ばす。
    // ★kakera の行には触らない（updated_at を進めない）
    stmts.push(
      db
        .prepare(
          `INSERT INTO katachi_kakera (katachi_id, kakera_id, sort_order)
           SELECT ?, k.id, ? FROM kakera k
            WHERE k.id = ? AND NOT EXISTS (SELECT 1 FROM katachi_kakera kk WHERE kk.kakera_id = k.id)`
        )
        .bind(input.id, (i + 1) * 100, kid)
    );
  });
  await db.batch(stmts);
  return await getKatachiDetail(db, input.id);
}

/**
 * かたちの日付・題・並びを変える。
 * ★katachi.updated_at は日付か題が実際に変わったときだけ進める（並べ替えだけなら katachi の行に触らない）。
 * ★並べ替えは katachi_kakera だけを書き換える（kakera.updated_at は進めない）。
 * ★日記になったかたちは日付を変えられない（変えると次の書き出しで別の日付のファイルができ、
 *   古い日付の記事が astro-blog に取り残されるため）。
 */
export async function updateKatachi(
  db: D1Database,
  id: string,
  patch: { date?: string; title?: string; order?: string[] }
): Promise<{ detail: KatachiDetail; oldDate: string }> {
  const before = await getKatachiRow(db, id);
  if (!before) throw new ApiError(404, 'そのかたちはありません');

  const nextDate = patch.date ?? before.date;
  const nextTitle = patch.title ?? before.title;

  if (nextDate !== before.date) {
    const nikki = await getNikkiRow(db, id);
    if (nikki) throw new ApiError(409, '日記になったかたちは日付を変えられません');
    const dup = await db
      .prepare('SELECT id FROM katachi WHERE date = ? AND id != ?')
      .bind(nextDate, id)
      .first<{ id: string }>();
    if (dup) throw new ApiError(409, `${nextDate} のかたちはもうあります（1日にひとつです）`);
  }

  const stmts: D1PreparedStatement[] = [];
  if (nextDate !== before.date || nextTitle !== before.title) {
    stmts.push(
      db
        .prepare('UPDATE katachi SET date = ?, title = ?, updated_at = ? WHERE id = ?')
        .bind(nextDate, nextTitle, nowJst(), id)
    );
  }
  if (patch.order) {
    patch.order.forEach((kid, i) => {
      stmts.push(
        db
          .prepare('UPDATE katachi_kakera SET sort_order = ? WHERE katachi_id = ? AND kakera_id = ?')
          .bind((i + 1) * 100, id, kid)
      );
    });
  }
  if (stmts.length) await db.batch(stmts);
  return { detail: await getKatachiDetail(db, id), oldDate: before.date };
}

/**
 * かたちを解く。中のかけらは流れに戻る。
 * ★日記になったかたちは解けない（astro-blog に記事だけ残って管理から外れるため・設計 §3）。
 */
export async function dissolveKatachi(db: D1Database, id: string): Promise<Katachi> {
  const katachi = await getKatachiRow(db, id);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const nikki = await getNikkiRow(db, id);
  if (nikki) throw new ApiError(409, '日記になったかたちは解けません');

  // 置き場所の行は ON DELETE CASCADE でも消えるが、並びを読み違えないよう明示して先に消す。
  // ★kakera の行には触らない。nikki_kakera も触らない（書き出しの記録。日記済みはそもそもここに来ない）
  await db.batch([
    db.prepare('DELETE FROM katachi_kakera WHERE katachi_id = ?').bind(id),
    db.prepare('DELETE FROM katachi WHERE id = ?').bind(id),
  ]);
  return katachi;
}

/**
 * かけら1枚をかたちから外して流れへ戻す（日記の有無にかかわらず可）。
 * ★置き場所の行だけを消す。kakera.updated_at は進めず、nikki_kakera（書き出しの記録）も消さない。
 */
export async function detachKakera(db: D1Database, katachiId: string, kakeraId: string): Promise<Kakera> {
  const k = await getKakera(db, kakeraId);
  if (!k || k.katachi_id !== katachiId) throw new ApiError(404, 'そのかたちにそのかけらはありません');
  await db
    .prepare('DELETE FROM katachi_kakera WHERE katachi_id = ? AND kakera_id = ?')
    .bind(katachiId, kakeraId)
    .run();
  return { ...k, katachi_id: null, sort_order: null };
}

/**
 * 日記にした記録を書く（毎回組み直すので、出したかけらは丸ごと入れ替える）。
 * ★nikki_kakera を書き換えてよいのはここだけ。
 */
export async function recordNikki(
  db: D1Database,
  katachiId: string,
  slug: string,
  kakeraIds: string[]
): Promise<void> {
  const now = nowJst();
  const existing = await getNikkiRow(db, katachiId);
  const stmts: D1PreparedStatement[] = [
    existing
      ? db
          .prepare('UPDATE nikki SET slug = ?, updated_at = ? WHERE katachi_id = ?')
          .bind(slug, now, katachiId)
      : db
          .prepare('INSERT INTO nikki (katachi_id, slug, published_at, updated_at) VALUES (?, ?, ?, ?)')
          .bind(katachiId, slug, now, now),
    db.prepare('DELETE FROM nikki_kakera WHERE katachi_id = ?').bind(katachiId),
  ];
  kakeraIds.forEach((kid, i) => {
    stmts.push(
      db
        .prepare('INSERT INTO nikki_kakera (katachi_id, kakera_id, position) VALUES (?, ?, ?)')
        .bind(katachiId, kid, i + 1)
    );
  });
  await db.batch(stmts);
}

/* ---------------- リンクカード（リンクカード設計 §3／migrations/0002） ---------------- */

export interface LinkCardRow {
  url: string;
  status: 'ok' | 'failed';
  title: string | null;
  description: string | null;
  site_name: string | null;
  final_url: string | null;
  image_key: string | null;
  error: string | null;
  fetched_at: string;
  updated_at: string;
}

/** D1 の束縛変数は1文あたり100個まで。余裕を持って刻む。 */
const IN_CHUNK = 90;

export async function getLinkCardRows(db: D1Database, urls: string[]): Promise<LinkCardRow[]> {
  const unique = [...new Set(urls)];
  const out: LinkCardRow[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const part = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM link_card WHERE url IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<LinkCardRow>();
    out.push(...(results ?? []));
  }
  return out;
}

export async function upsertLinkCard(
  db: D1Database,
  row: Omit<LinkCardRow, 'fetched_at' | 'updated_at'>
): Promise<void> {
  const now = nowJst();
  await db
    .prepare(
      `INSERT INTO link_card (url, status, title, description, site_name, final_url, image_key, error, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         status = excluded.status, title = excluded.title, description = excluded.description,
         site_name = excluded.site_name, final_url = excluded.final_url, image_key = excluded.image_key,
         error = excluded.error, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`
    )
    .bind(row.url, row.status, row.title, row.description, row.site_name, row.final_url, row.image_key, row.error, now, now)
    .run();
}

/** 画面に渡す形にする。failed は呼ぶ側で落としておく。 */
function toLinkCard(row: LinkCardRow): LinkCard {
  const domain = domainOf(row.final_url ?? row.url) || domainOf(row.url);
  const image = row.image_key && isSafePhotoKey(row.image_key) ? photoUrlFor(row.image_key) : null;
  return {
    url: row.url,
    title: row.title || domain,
    description: row.description ?? '',
    siteName: row.site_name || domain,
    domain,
    image,
  };
}

/**
 * かけらの本文に出てくる「カードにしうる URL」のキャッシュを1クエリで引く（status='ok' だけ）。
 * ⚠️ 流れ・かたちの取得口に同梱するためのもの。ここが失敗しても（表がまだ無い等）画面は壊さず、
 * カードなし＝素のリンクで出す。
 */
export async function cardsForBodies(db: D1Database, bodies: string[]): Promise<LinkCards> {
  const keys = bodies.flatMap((b) => parseCardUrls(b).map((t) => t.key));
  if (!keys.length) return {};
  try {
    const rows = await getLinkCardRows(db, keys);
    const cards: LinkCards = {};
    for (const r of rows) if (r.status === 'ok') cards[r.url] = toLinkCard(r);
    return cards;
  } catch (e) {
    console.error('[link-card] キャッシュを引けませんでした', e instanceof Error ? e.message : e);
    return {};
  }
}

/** かたちの詳細にカードを添える（GET / POST / PATCH /api/katachi の戻り）。 */
export async function withCards(db: D1Database, detail: KatachiDetail): Promise<KatachiDetail> {
  return { ...detail, cards: await cardsForBodies(db, detail.kakera.map((k) => k.body)) };
}

/** URL を含みうるかけらの本文（補填用）。 */
export async function listBodiesWithUrls(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT body FROM kakera WHERE body LIKE '%http%' ORDER BY written_at DESC")
    .all<{ body: string }>();
  return (results ?? []).map((r) => r.body);
}

/* ---------------- 検索（第二段・かたちの全文検索。設計 §3／migrations/0001） ---------------- */

/** trigram は3文字未満のクエリを扱えないので、その手前は LIKE に落とす。 */
const MIN_TRIGRAM_LEN = 3;

/** 文字数（サロゲートペアも1文字と数える）。 */
function charLength(s: string): number {
  return Array.from(s).length;
}

/**
 * 利用者が打った文字列を素直な一語として扱う。
 * FTS5 のクエリ構文（" * AND OR NEAR 等）をそのまま渡すと構文エラーで 500 になるため、
 * ダブルクォートで包んで中の " を "" にエスケープしてから MATCH に渡す。
 */
function escapeFtsPhrase(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

/** LIKE の特殊文字（% _ \）をエスケープする。 */
function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}

interface SearchRow {
  kakera_id: string;
  katachi_id: string | null;
  body: string;
}

/**
 * かたちの全文検索。かたちに属さないかけら（流れ）は対象外——
 * kakera_fts 自体は kakera 全体（流れも含む）を索引しているが（後から流れも検索できるように）、
 * ここで katachi_kakera に行があるもの（INNER JOIN）に絞る。
 */
export async function searchKatachi(db: D1Database, rawQuery: string): Promise<SearchResult[]> {
  const q = rawQuery.trim();
  if (!q) return [];

  let rows: SearchRow[];
  if (charLength(q) < MIN_TRIGRAM_LEN) {
    const { results } = await db
      .prepare(
        `SELECT k.id AS kakera_id, kk.katachi_id AS katachi_id, k.body AS body
           FROM kakera k JOIN katachi_kakera kk ON kk.kakera_id = k.id
          WHERE k.body LIKE ? ESCAPE '\\'`
      )
      .bind('%' + escapeLikePattern(q) + '%')
      .all<SearchRow>();
    rows = results ?? [];
  } else {
    const { results } = await db
      .prepare(
        `SELECT k.id AS kakera_id, kk.katachi_id AS katachi_id, k.body AS body
           FROM kakera_fts
           JOIN kakera k ON k.id = kakera_fts.kakera_id
           JOIN katachi_kakera kk ON kk.kakera_id = k.id
          WHERE kakera_fts MATCH ?`
      )
      .bind(escapeFtsPhrase(q))
      .all<SearchRow>();
    rows = results ?? [];
  }
  if (!rows.length) return [];

  const katachiIds = [...new Set(rows.map((r) => r.katachi_id!))];
  const placeholders = katachiIds.map(() => '?').join(',');
  const { results: katachiRows } = await db
    .prepare(
      `SELECT k.*, (SELECT 1 FROM nikki n WHERE n.katachi_id = k.id) AS has_nikki
         FROM katachi k WHERE k.id IN (${placeholders}) ORDER BY k.date DESC`
    )
    .bind(...katachiIds)
    .all<Katachi & { has_nikki: number | null }>();

  const matchesByKatachi = new Map<string, SearchMatch[]>();
  for (const r of rows) {
    const list = matchesByKatachi.get(r.katachi_id!) ?? [];
    list.push({ kakera_id: r.kakera_id, excerpt: buildExcerpt(r.body, q) });
    matchesByKatachi.set(r.katachi_id!, list);
  }

  return (katachiRows ?? []).map((k) => ({
    id: k.id,
    date: k.date,
    title: k.title,
    updated_at: k.updated_at,
    has_nikki: !!k.has_nikki,
    matches: matchesByKatachi.get(k.id) ?? [],
  }));
}
