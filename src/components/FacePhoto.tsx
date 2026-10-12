import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { hiddenFaces, normalizeBox, type PhotoFace, type PhotoFaceState } from '../lib/publish/photo-face';

/**
 * 変換ページの写真 1 枚と、その上の顔の枠（顔モザイク設計 §3.5）。
 *  - 隠す枠はモザイクの見た目、出す枠は細い線だけ。枠をタップで切り替え
 *  - 「囲む」で囲むモードに入り、指（またはマウス）のドラッグで四角を描く。描いた枠は「隠す」で始まる
 *  - 手で足した枠は × か長押しで消せる
 * ⚠️ 指の操作は pointer events だけで受ける（iPhone の Safari でも同じ）。囲むモードの間だけ touch-action: none でスクロールを止める。
 * ⚠️ 見た目のモザイクは目安（CSS）。公開されるのは書き出しの前に作るモザイク（faces.ts）。
 */

export interface FacePhotoProps {
  src: string;
  state: PhotoFaceState | null;
  /** 検出中か */
  scanning: boolean;
  /** 検出に失敗した理由 */
  error: string | null;
  onChange: (faces: PhotoFace[]) => void;
  onRetry: () => void;
}

const LONG_PRESS_MS = 600;
/** これより小さく描いた枠は、タップの打ち損じとみなして足さない（比率） */
const MIN_DRAW = 0.02;

function newManualId(): string {
  return 'm' + Math.random().toString(36).slice(2, 10);
}

export function FacePhoto({ src, state, scanning, error, onChange, onRetry }: FacePhotoProps): JSX.Element {
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);
  /** 長押しで消した直後のタップ（click）を切り替えに数えない */
  const swallowClick = useRef(false);

  const faces = state?.faces ?? [];
  const hiddenN = hiddenFaces(faces).length;
  const shownN = faces.length - hiddenN;

  const pointOf = (e: PointerEvent): { x: number; y: number } => {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const toggle = (id: string) => onChange(faces.map((f) => (f.id === id ? { ...f, shown: !f.shown } : f)));
  const remove = (id: string) => onChange(faces.filter((f) => f.id !== id));

  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  let status: JSX.Element | string;
  if (error) status = <span class="face-err">顔を調べられませんでした（{error}）</span>;
  else if (scanning || !state) status = '顔を調べています…';
  else if (!state.scanned) status = '顔はまだ調べていません';
  else if (!faces.length) status = '顔は見つかりませんでした';
  else
    status = (
      <>
        顔 隠す<b>{hiddenN}</b>／出す<b>{shownN}</b>
      </>
    );

  const canEdit = !!state?.scanned && !scanning;

  return (
    <div class="face-photo">
      <div
        ref={stageRef}
        class={'face-stage' + (drawing ? ' drawing' : '')}
        onPointerDown={(e) => {
          if (!drawing) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = pointOf(e);
          setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => {
          if (!drawing || !draft) return;
          e.preventDefault();
          const p = pointOf(e);
          setDraft({ ...draft, x1: p.x, y1: p.y });
        }}
        onPointerUp={(e) => {
          if (!drawing || !draft) return;
          const p = pointOf(e);
          const box = normalizeBox({
            x: Math.min(draft.x0, p.x),
            y: Math.min(draft.y0, p.y),
            w: Math.abs(p.x - draft.x0),
            h: Math.abs(p.y - draft.y0),
          });
          setDraft(null);
          if (!box || box.w < MIN_DRAW || box.h < MIN_DRAW) return; // 打ち損じ。囲むモードのまま描き直せる
          setDrawing(false);
          onChange([...faces, { id: newManualId(), ...box, source: 'manual', shown: false }]);
        }}
        onPointerCancel={() => setDraft(null)}
      >
        <img src={src} alt="" loading="lazy" draggable={false} />
        {faces.map((f) => (
          <div
            key={f.id}
            role="button"
            tabIndex={drawing ? -1 : 0}
            aria-pressed={!f.shown}
            aria-label={`${f.source === 'manual' ? '囲んだ枠' : '顔'}（${f.shown ? '出す' : '隠す'}）`}
            class={'face-box' + (f.shown ? ' shown' : ' masked') + (f.source === 'manual' ? ' manual' : '')}
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
            onPointerDown={() => {
              if (drawing || f.source !== 'manual') return;
              clearPress();
              pressTimer.current = window.setTimeout(() => {
                pressTimer.current = null;
                swallowClick.current = true;
                remove(f.id);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={clearPress}
            onPointerLeave={clearPress}
            onPointerCancel={clearPress}
            onContextMenu={(e) => f.source === 'manual' && e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (swallowClick.current) {
                swallowClick.current = false;
                return;
              }
              if (!drawing && canEdit) toggle(f.id);
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && canEdit) {
                e.preventDefault();
                toggle(f.id);
              }
            }}
          >
            {f.source === 'manual' && !drawing ? (
              <button
                type="button"
                class="face-del"
                aria-label="この枠を消す"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(f.id);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {draft ? (
          <div
            class="face-draft"
            style={{
              left: `${Math.min(draft.x0, draft.x1) * 100}%`,
              top: `${Math.min(draft.y0, draft.y1) * 100}%`,
              width: `${Math.abs(draft.x1 - draft.x0) * 100}%`,
              height: `${Math.abs(draft.y1 - draft.y0) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <div class="face-bar">
        <span class="face-status">{status}</span>
        {error ? (
          <button type="button" class="face-btn" onClick={onRetry}>
            もう一度調べる
          </button>
        ) : null}
        <button
          type="button"
          class={'face-btn' + (drawing ? ' on' : '')}
          aria-pressed={drawing}
          disabled={!canEdit}
          onClick={() => {
            setDraft(null);
            setDrawing(!drawing);
          }}
        >
          {drawing ? '囲むのをやめる' : '囲む'}
        </button>
      </div>
      {drawing ? <p class="face-hint">隠したいところを指でなぞって囲んでください。</p> : null}
    </div>
  );
}
