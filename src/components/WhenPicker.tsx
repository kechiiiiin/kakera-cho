import type { JSX } from 'preact';
import { nowJst } from '../lib/time';
import { dateOf, dayGroupHeading, timeOf } from './format';

/** written_at（+09:00 付き）→ datetime-local の値 'YYYY-MM-DDTHH:MM'。文字列を切るだけ（端末の時計のオフセットを混ぜない） */
export function toLocalValue(writtenAt: string): string {
  return writtenAt.slice(0, 16);
}

/** datetime-local の値 → written_at（JST とみなす・秒は 00） */
export function fromLocalValue(v: string): string {
  return v.slice(0, 16) + ':00+09:00';
}

/** 分の単位で同じ日時か（秒は見ない） */
export function sameMinute(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16);
}

/** max を今へ進める。値が同じなら触らない（PC の Chrome は属性を書くだけで日時欄が作り直され、押した click が消えることがある） */
function syncMax(el: HTMLInputElement): void {
  const now = toLocalValue(nowJst());
  if (el.max !== now) el.max = now;
}

/**
 * かけらの日時（案A・かけら時刻の指定と修正設計 2026-10-12）。保存ボタンの左に置く。
 *  - 灰色・等幅・点線の下線で「10-12 (月) 18:15」
 *  - 文字の上に透明な datetime-local を重ね、押すと端末の日時の選び方が出る。max は今（未来は選べない）
 *  - 変えたら朱にし、右に戻すボタン（書く欄は「いまに戻す」、直すは「元に戻す」）
 */
export function WhenPicker({
  value,
  changed,
  resetLabel,
  onChange,
  onReset,
  disabled,
}: {
  /** written_at の形（+09:00 付き） */
  value: string;
  changed: boolean;
  resetLabel: string;
  onChange: (writtenAt: string) => void;
  onReset: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <span class="when-cluster">
      <label class={changed ? 'when changed' : 'when'}>
        <span class="when-text">
          {dayGroupHeading(dateOf(value))} {timeOf(value)}
        </span>
        <input
          type="datetime-local"
          aria-label="書いた日時"
          value={toLocalValue(value)}
          max={toLocalValue(nowJst())}
          disabled={disabled}
          // 開く直前に max を今へ進める（画面を開いたままにしていても、今より先は選べないように）
          onFocus={(e) => syncMax(e.currentTarget as HTMLInputElement)}
          // PC の Chrome は日付・時刻の区画を押すとその区画にフォーカスするだけなので、押したら必ずピッカーを開く
          // （max を今へ進めてから。非対応・すでに開いている等の例外は黙って無視し、従来の動きに任せる）
          onClick={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            if (el.disabled) return;
            syncMax(el);
            try {
              el.showPicker();
            } catch {
              /* 非対応・すでに開いている等 */
            }
          }}
          onChange={(e) => {
            const v =(e.currentTarget as HTMLInputElement).value;
            if (!v) return; // iOS の「消去」は無視する（日時の無いかけらは作らない）
            const max = toLocalValue(nowJst());
            // iOS のホイールは max を守らないことがあるので、ここで今に丸める
            onChange(fromLocalValue(v > max ? max : v));
          }}
        />
      </label>
      {changed ? (
        <button type="button" class="when-reset" disabled={disabled} onClick={onReset}>
          {resetLabel}
        </button>
      ) : null}
    </span>
  );
}
