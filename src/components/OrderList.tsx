import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
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
  // handlers を毎回作り直しても、掴んだときの参照が使われるよう ref 越しに読む
  const handlersRef = useRef({ onReorder });
  handlersRef.current.onReorder = onReorder;

  const handlers = {
    onReorder: (order: string[]) => handlersRef.current.onReorder(order),
    onKeyMove: (id: string, dir: -1 | 1) => {
      const order = items.map((i) => i.id);
      const idx = order.indexOf(id);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= order.length) return;
      [order[idx], order[next]] = [order[next]!, order[idx]!];
      handlersRef.current.onReorder(order);
    },
  };

  return (
    <div class="assembled">
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
