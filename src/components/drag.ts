// 並べ替え（かたちにする／日記にする 共通）。設計 §8。
//
// ⚠️ Pointer Events（setPointerCapture）で実装する。`draggable` 属性は使わない（モバイルで動かない）。
// 持ち手からは即座に、本文からは長押し 400ms で掴める。長押し前に約8px 動いたらスクロールに譲る。
// 落ちる位置にプレースホルダの隙間。端で自動スクロール。持ち手は Tab でフォーカスでき矢印キーでも動く。

const LONGPRESS_MS = 400;
const MOVE_CANCEL_PX = 8;
const EDGE_ZONE = 46;
const SCROLL_SPEED = 10;

export interface DragHandlers {
  onReorder: (order: string[]) => void;
  onKeyMove?: (id: string, dir: -1 | 1) => void;
}

interface Active {
  containerEl: HTMLElement;
  handlers: DragHandlers;
  rowEl: HTMLElement;
  placeholder: HTMLElement;
  id: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  homeEl: HTMLElement;
  lastClientX: number;
  lastClientY: number;
  scrollParent: HTMLElement | null;
  rafId: number | null;
}

let active: Active | null = null;
let suppressClickUntil = 0;

export function isClickSuppressed(): boolean {
  return Date.now() < suppressClickUntil;
}

function rowsHost(): HTMLElement {
  return document.getElementById('frame') ?? document.body;
}

function getScrollParent(containerEl: HTMLElement): HTMLElement | null {
  let node = containerEl.parentElement;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

function place(clientX: number, clientY: number): void {
  if (!active) return;
  const homeRect = active.homeEl.getBoundingClientRect();
  active.rowEl.style.left = clientX - active.offsetX - homeRect.left + active.homeEl.scrollLeft + 'px';
  active.rowEl.style.top = clientY - active.offsetY - homeRect.top + active.homeEl.scrollTop + 'px';
}

function computeInsertBefore(clientY: number): Element | null {
  if (!active) return null;
  const children = Array.from(active.containerEl.children).filter((el) => el !== active!.placeholder);
  for (const child of children) {
    const r = child.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return child;
  }
  return null;
}

function movePlaceholder(clientY: number): void {
  if (!active) return;
  const insertBefore = computeInsertBefore(clientY);
  if (insertBefore === active.placeholder) return;
  if (active.placeholder.nextSibling === insertBefore) return;

  const siblings = Array.from(active.containerEl.children).filter(
    (el) => el !== active!.placeholder && el !== active!.rowEl
  ) as HTMLElement[];
  const before = siblings.map((el) => el.getBoundingClientRect());

  if (insertBefore) active.containerEl.insertBefore(active.placeholder, insertBefore);
  else active.containerEl.appendChild(active.placeholder);

  // 隙間が動いたぶんだけ、周りを滑らかに追従させる（FLIP）
  siblings.forEach((el, i) => {
    const b = before[i]!;
    const a = el.getBoundingClientRect();
    const dy = b.top - a.top;
    if (dy) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 180ms ease';
        el.style.transform = '';
      });
    }
  });
}

function onMove(e: PointerEvent): void {
  if (!active || e.pointerId !== active.pointerId) return;
  e.preventDefault();
  active.lastClientX = e.clientX;
  active.lastClientY = e.clientY;
  place(e.clientX, e.clientY);
  movePlaceholder(e.clientY);
}

function autoScrollStep(): void {
  if (!active) return;
  const y = active.lastClientY;
  let top: number, bottom: number;
  if (active.scrollParent) {
    const r = active.scrollParent.getBoundingClientRect();
    top = r.top;
    bottom = r.bottom;
  } else {
    top = 0;
    bottom = window.innerHeight;
  }
  let d = 0;
  if (y < top + EDGE_ZONE) d = -SCROLL_SPEED;
  else if (y > bottom - EDGE_ZONE) d = SCROLL_SPEED;
  if (!d) return;
  if (active.scrollParent) active.scrollParent.scrollTop += d;
  else window.scrollBy(0, d);
  movePlaceholder(active.lastClientY);
  place(active.lastClientX, active.lastClientY);
}

function tick(): void {
  if (!active) return;
  autoScrollStep();
  active.rafId = requestAnimationFrame(tick);
}

function onUp(e: PointerEvent): void {
  if (!active || e.pointerId !== active.pointerId) return;
  finish();
}

function finish(): void {
  if (!active) return;
  const { containerEl, placeholder, rowEl, id, handlers } = active;
  if (active.rafId) cancelAnimationFrame(active.rafId);
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onUp);
  document.documentElement.classList.remove('drag-lock');
  document.body.classList.remove('drag-lock');
  suppressClickUntil = Date.now() + 300;

  const order = Array.from(containerEl.children)
    .map((el) => (el === placeholder ? id : el.getAttribute('data-drag-key')))
    .filter((v): v is string => !!v);

  // 掴んでいた行を、隙間のあった場所へ戻す。
  // ⚠️ 行の DOM ノードは Preact のもの。消してしまうと次の差分更新が壊れるので、
  //    必ずコンテナの中へ返す（並び順のずれは keyed diff が直す）。
  placeholder.replaceWith(rowEl);
  rowEl.classList.remove('dragging');
  rowEl.style.position = '';
  rowEl.style.width = '';
  rowEl.style.zIndex = '';
  rowEl.style.left = '';
  rowEl.style.top = '';

  Array.from(containerEl.children).forEach((el) => {
    (el as HTMLElement).style.transition = '';
    (el as HTMLElement).style.transform = '';
  });

  active = null;
  handlers.onReorder(order);
}

function begin(
  containerEl: HTMLElement,
  handlers: DragHandlers,
  rowEl: HTMLElement,
  pointerId: number,
  clientX: number,
  clientY: number
): void {
  if (active) return;
  const rect = rowEl.getBoundingClientRect();
  const homeEl = rowsHost();

  const placeholder = document.createElement(rowEl.tagName);
  placeholder.className = 'drag-placeholder ' + (rowEl.tagName === 'LI' ? 'ph-frag' : 'ph-assembled');
  placeholder.style.height = rect.height + 'px';
  containerEl.insertBefore(placeholder, rowEl.nextSibling);

  rowEl.classList.add('dragging');
  rowEl.style.position = 'absolute';
  rowEl.style.width = rect.width + 'px';
  rowEl.style.zIndex = '999';
  homeEl.appendChild(rowEl);

  document.documentElement.classList.add('drag-lock');
  document.body.classList.add('drag-lock');
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* 選択の解除に失敗しても続ける */
  }

  active = {
    containerEl,
    handlers,
    rowEl,
    placeholder,
    id: rowEl.getAttribute('data-drag-key') ?? '',
    pointerId,
    offsetX: clientX - rect.left,
    offsetY: clientY - rect.top,
    homeEl,
    lastClientX: clientX,
    lastClientY: clientY,
    scrollParent: getScrollParent(containerEl),
    rafId: null,
  };
  try {
    rowEl.setPointerCapture(pointerId);
  } catch {
    /* 掴み損ねても document のイベントで拾える */
  }
  place(clientX, clientY);
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  active.rafId = requestAnimationFrame(tick);
}

/**
 * 1行を掴めるようにする。
 * `isDraggable` が false を返す間は掴めない（開いている＝編集中のかけらは掴めない）。
 */
export function wireRow(
  containerEl: HTMLElement,
  handlers: DragHandlers,
  rowEl: HTMLElement,
  isDraggable?: () => boolean
): void {
  const grip = rowEl.querySelector<HTMLButtonElement>('.drag-handle');
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      if (grip.disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      begin(containerEl, handlers, rowEl, e.pointerId, e.clientX, e.clientY);
    });
    if (handlers.onKeyMove) {
      grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        handlers.onKeyMove!(rowEl.getAttribute('data-drag-key') ?? '', e.key === 'ArrowUp' ? -1 : 1);
      });
    }
  }

  rowEl.addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest('.drag-handle')) return;
    if (isDraggable && !isDraggable()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let lastX = startX;
    let lastY = startY;

    const timer = setTimeout(() => {
      cleanup();
      begin(containerEl, handlers, rowEl, pointerId, lastX, lastY);
    }, LONGPRESS_MS);

    function onPending(ev: PointerEvent): void {
      if (ev.pointerId !== pointerId) return;
      lastX = ev.clientX;
      lastY = ev.clientY;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // 長押し前に動いたらスクロールに譲る
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX) cleanup();
    }
    function onPendingUp(ev: PointerEvent): void {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    }
    function cleanup(): void {
      clearTimeout(timer);
      document.removeEventListener('pointermove', onPending);
      document.removeEventListener('pointerup', onPendingUp);
      document.removeEventListener('pointercancel', onPendingUp);
    }
    document.addEventListener('pointermove', onPending);
    document.addEventListener('pointerup', onPendingUp);
    document.addEventListener('pointercancel', onPendingUp);
  });
}

export const GRIP_SVG =
  '<svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true" focusable="false">' +
  '<circle cx="3" cy="3" r="1.6" fill="currentColor"></circle><circle cx="11" cy="3" r="1.6" fill="currentColor"></circle>' +
  '<circle cx="3" cy="9" r="1.6" fill="currentColor"></circle><circle cx="11" cy="9" r="1.6" fill="currentColor"></circle>' +
  '<circle cx="3" cy="15" r="1.6" fill="currentColor"></circle><circle cx="11" cy="15" r="1.6" fill="currentColor"></circle>' +
  '</svg>';
