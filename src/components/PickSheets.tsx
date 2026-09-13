import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Kakera, KatachiSummary } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { textForPick } from '../lib/card/pick';
import { dateHeading, dateOf, timeOf } from './format';
import { RowThumb } from './RichText';

/**
 * 既にあるかたちへ、あとからかけらを足すための「選ぶ一覧」（設計 §3・2026-09-13 決定）。
 * 下から出るシートに、「かたちにする」と同じ選択行（.pick-row とチェック）を並べる。
 *  - KakeraPickSheet: かたちの読む画面（編集モード）から。かけらたちを複数選ぶ
 *  - KatachiPickSheet: かけらたちの編集欄から。行き先のかたちを日付で一つ選ぶ
 */

function Sheet({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ComponentChildren;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onClick={onClose} />
      <div class="sheet pick-sheet" role="dialog" aria-modal="true">
        <div class="grip" />
        {children}
      </div>
    </div>
  );
}

export function KakeraPickSheet({
  nagare,
  cards,
  loaded,
  onClose,
  onAdd,
}: {
  nagare: Kakera[];
  cards: LinkCards;
  loaded: boolean;
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<void>;
}): JSX.Element {
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(id: string): void {
    setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  }

  return (
    <Sheet onClose={onClose}>
      <p class="sh-title">かけらを足す</p>
      <p class="sh-snip">かたちの中は、書いた順に並びます。</p>
      <div class="pick-sheet-list">
        {!loaded ? (
          <p class="empty-note">読み込んでいます</p>
        ) : !nagare.length ? (
          <p class="empty-note">まだかたちになっていないかけらがありません</p>
        ) : (
          nagare.map((k) => {
            const checked = chosen.includes(k.id);
            return (
              <div class="pick-row" key={k.id} onClick={() => toggle(k.id)}>
                <div class={'checkbox' + (checked ? ' checked' : '')}>{checked ? '✓' : ''}</div>
                <div class="pick-text">
                  <span class="pick-excerpt">{textForPick(k.body, cards)}</span>
                  <div class="pick-time">
                    {dateHeading(dateOf(k.written_at))} {timeOf(k.written_at)}
                  </div>
                </div>
                <RowThumb text={k.body} />
              </div>
            );
          })
        )}
      </div>
      <div class="sh-actions">
        <button type="button" class="btn-ghost" disabled={busy} onClick={onClose}>
          やめる
        </button>
        <button
          type="button"
          class="btn-cta"
          disabled={!chosen.length || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd(chosen);
            } finally {
              setBusy(false);
            }
          }}
        >
          足す（{chosen.length}）
        </button>
      </div>
    </Sheet>
  );
}

export function KatachiPickSheet({
  list,
  loaded,
  onClose,
  onPut,
}: {
  /** date DESC（新しい順）で届く */
  list: KatachiSummary[];
  loaded: boolean;
  onClose: () => void;
  onPut: (katachiId: string) => Promise<void>;
}): JSX.Element {
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Sheet onClose={onClose}>
      <p class="sh-title">かたちに入れる</p>
      <p class="sh-snip">行き先のかたちを選びます。かたちの中は、書いた順に並びます。</p>
      <div class="pick-sheet-list">
        {!loaded ? (
          <p class="empty-note">読み込んでいます</p>
        ) : !list.length ? (
          <p class="empty-note">まだかたちがありません</p>
        ) : (
          list.map((k) => {
            const checked = chosen === k.id;
            return (
              <div class="pick-row" key={k.id} onClick={() => setChosen(checked ? null : k.id)}>
                <div class={'checkbox' + (checked ? ' checked' : '')}>{checked ? '✓' : ''}</div>
                <div class="pick-text">
                  <div class="pick-date">{dateHeading(k.date)}</div>
                  {k.title ? <span class="pick-excerpt">{k.title}</span> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div class="sh-actions">
        <button type="button" class="btn-ghost" disabled={busy} onClick={onClose}>
          やめる
        </button>
        <button
          type="button"
          class="btn-cta"
          disabled={!chosen || busy}
          onClick={async () => {
            if (!chosen) return;
            setBusy(true);
            try {
              await onPut(chosen);
            } finally {
              setBusy(false);
            }
          }}
        >
          入れる
        </button>
      </div>
    </Sheet>
  );
}
