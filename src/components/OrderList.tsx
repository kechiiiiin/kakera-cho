import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { GRIP_SVG, wireRow } from './drag';

export interface OrderItem {
  id: string;
  content: JSX.Element | string;
}

/**
 * ドラッグで並べ替える列（かたちにする／日記にする 共通）。
 * 持ち手は Tab でフォーカスでき、矢印キーでも動く。
 */
export function OrderList({
  items,
  onReorder,
}: {
  items: OrderItem[];
  onReorder: (order: string[]) => void;
}): JSX.Element {
  // handlers を毎回作り直しても、掴んだときの参照が使われるよう ref 越しに読む。
  // ⚠️ wireRow は行の DOM ノードが最初に作られたときに一度だけ呼ばれる（並べ替えではキーが同じ
  //    DOM ノードを Preact が使い回すので ref コールバックは再発火しない）。そのため handlers
  //    オブジェクト自体は「初回の render」のものが永久に使われる。中の関数が items を直接クロージャで
  //    捕まえると、初回時点の並びのまま固まって矢印キーが正しく動かなくなる（実際に起きていた不具合）。
  //    items も ref 越しに読むことで、どの render の handlers が呼ばれても常に最新の並びを使う。
  const stateRef = useRef({ onReorder, items });
  stateRef.current = { onReorder, items };

  // ブラウザは、フォーカス中の要素を DOM 上の別の位置へ差し替える（insertBefore で
  // 兄弟の並びを変える）と、同じノードのままでもフォーカスを外す（body に落ちる）。
  // Preact の再描画で行の DOM ノード自体は使い回されるが、並びが変わった直後に
  // このフォーカス外れが起きるので、矢印キーで動かした持ち手へ毎回フォーカスを戻す。
  const focusIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const id = focusIdRef.current;
    if (!id) return;
    focusIdRef.current = null;
    containerRef.current
      ?.querySelector<HTMLButtonElement>(`[data-drag-key="${CSS.escape(id)}"] .drag-handle`)
      ?.focus();
  });

  const handlers = {
    onReorder: (order: string[]) => stateRef.current.onReorder(order),
    onKeyMove: (id: string, dir: -1 | 1) => {
      const order = stateRef.current.items.map((i) => i.id);
      const idx = order.indexOf(id);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= order.length) return;
      [order[idx], order[next]] = [order[next]!, order[idx]!];
      focusIdRef.current = id;
      stateRef.current.onReorder(order);
    },
  };

  return (
    <div class="assembled" ref={containerRef}>
      {items.map((item, idx) => (
        <div
          class="assembled-item"
          data-drag-key={item.id}
          key={item.id}
          ref={(el) => {
            if (!el || el.dataset.wired) return;
            el.dataset.wired = '1';
            const container = el.parentElement;
            if (container) wireRow(container, handlers, el);
          }}
        >
          <button
            type="button"
            class="drag-handle"
            aria-label="ならべかえ"
            dangerouslySetInnerHTML={{ __html: GRIP_SVG }}
          />
          <span class="assembled-num">{idx + 1}</span>
          <div class="assembled-text">{item.content}</div>
        </div>
      ))}
    </div>
  );
}
