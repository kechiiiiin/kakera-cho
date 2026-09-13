import type { JSX } from 'preact';
import type { KatachiSummary } from '../lib/kakera/types';
import { dateLiterary } from './format';

/**
 * 日記（三つ目のタブ）。
 * かけら帳が日記にしたもの（nikki に行があるかたち）の一覧。新しい順に日付と題。
 * 題が無ければ文語の日付。
 * ※既存の 219 件（microCMS 移行分）はここに出さない。あれは blog-cms の管轄。
 */
export function NikkiListScreen({
  list,
  loaded,
  onOpen,
  onOpenNameMap,
}: {
  list: KatachiSummary[];
  loaded: boolean;
  onOpen: (id: string) => void;
  /** 名前の辞書（公開名変換）。滅多に触らないので隅に小さく置く */
  onOpenNameMap: () => void;
}): JSX.Element {
  return (
    <section>
      <div class="corner-row">
        <p class="page-date">日記</p>
        <button type="button" class="corner-link" onClick={onOpenNameMap}>
          名前の辞書
        </button>
      </div>
      <p class="page-sub">これまでに日記にしたものの一覧です。</p>
      {!loaded ? (
        <p class="empty-note">読み込んでいます</p>
      ) : !list.length ? (
        <p class="empty-note">まだ日記になったものがありません</p>
      ) : (
        list.map((k) => (
          <div class="article-row" key={k.id} onClick={() => onOpen(k.id)}>
            <div class="article-date">{k.date}</div>
            <div class="article-title">{k.title || dateLiterary(k.date)}</div>
          </div>
        ))
      )}
    </section>
  );
}
