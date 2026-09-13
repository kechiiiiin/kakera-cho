// 画面とサーバで共有する形。語彙は設計 §1 のまま（かけら／かたち／日記）。

import type { LinkCards } from '../card/types';

export interface Kakera {
  id: string;
  body: string;
  /** ISO8601(JST・+09:00 付き)。書いた日時。★不変 */
  written_at: string;
  /** 置き場所（katachi_kakera から導出。NULL = かけらたち＝未かたち）。kakera の列ではない */
  katachi_id: string | null;
  /** 本文を直したときだけ進む（公開名変換の選択の basis） */
  updated_at: string;
}

export interface Katachi {
  id: string;
  /** 'YYYY-MM-DD' */
  date: string;
  title: string;
  /**
   * 日記の説明文（原本・実名のまま。空なら frontmatter に書かない）。「日記にする」画面で書く。
   * ★ここを変えても updated_at は進めない（migrations/0007）
   */
  description: string;
  updated_at: string;
}

export interface Nikki {
  katachi_id: string;
  slug: string;
  published_at: string;
  updated_at: string;
}

/** かたち一覧の1行（日記になっているかの印つき）。 */
export interface KatachiSummary extends Katachi {
  has_nikki: boolean;
  /** 題が無いときに薄く出す、1枚目の冒頭 */
  lead: string;
}

/** かたち1つ＋中のかけら。 */
export interface KatachiDetail {
  katachi: Katachi;
  kakera: Kakera[];
  nikki: Nikki | null;
  /** 日記に出したかけらの id（`日記に出した` の印に使う） */
  published_ids: string[];
  /** 中のかけらに出てくる URL のリンクカード（取得口で同梱する。無ければ全部素のリンク） */
  cards?: LinkCards;
}

/** 検索でヒットしたかけら1枚（抜粋つき）。 */
export interface SearchMatch {
  kakera_id: string;
  /** ヒットした位置の前後を切り出した本文（画像記法は除いてある）。 */
  excerpt: string;
}

/** 検索結果の1行＝ヒットしたかたち＋その中のどのかけらがヒットしたか。 */
export interface SearchResult extends Katachi {
  has_nikki: boolean;
  matches: SearchMatch[];
}
