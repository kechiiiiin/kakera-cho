// リンクカードの、画面に渡す形（設計「リンクカード設計・詳細」§3.3）。
// ⚠️ status='failed' の行は画面に出さない（存在しないのと同じに扱う）。error は D1 の中だけ。

export interface LinkCard {
  /** 正規化済み。本文の URL と照合するキー */
  url: string;
  /** 空になることはない（無ければホスト名を入れる） */
  title: string;
  /** 無ければ '' */
  description: string;
  /** og:site_name。無ければホスト名（第二段の astro-blog 用に持っておく） */
  siteName: string;
  /** カードの一段目に出すドメイン（リダイレクト後の行き先のホスト名・先頭の www. は落とす） */
  domain: string;
  /** かけら帳では '/api/photo/kakera/cards/<hash>.<ext>'。無ければ null */
  image: string | null;
}

/** 画面へは「正規化 URL → カード」の辞書で渡す。 */
export type LinkCards = Record<string, LinkCard>;
