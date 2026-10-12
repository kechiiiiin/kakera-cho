import type { JSX } from 'preact';

// 「時刻を出す」のチェック（かけら時刻表示設計・2026-10-12）。かたちにする画面と、かたちの読む画面の「直す」で使う。
// 見た目はモック（attachments/かけら時刻表示モック.html）の .tg。本物の checkbox を隠して、箱を描く。

export function TimeToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label
      class={'time-toggle' + (disabled ? ' disabled' : '')}
      // 行を押すと選択が切り替わる画面（かたちにする）で、チェックの押下を行へ伝えない
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="time-toggle-box" aria-hidden="true">
        ✓
      </span>
      <span class="time-toggle-label">時刻を出す</span>
    </label>
  );
}

/** 「時刻を出すかけら n / m」と「全部に付ける／全部外す」。 */
export function TimeBulkBar({
  shown,
  total,
  disabled,
  onAll,
}: {
  shown: number;
  total: number;
  disabled?: boolean;
  onAll: (show: boolean) => void;
}): JSX.Element {
  return (
    <div class="time-bulk">
      <span class="time-bulk-count">
        時刻を出すかけら {shown} / {total}
      </span>
      <span class="time-bulk-btns">
        <button type="button" class="btn-ghost" disabled={disabled || shown === total} onClick={() => onAll(true)}>
          全部に付ける
        </button>
        <button type="button" class="btn-ghost" disabled={disabled || shown === 0} onClick={() => onAll(false)}>
          全部外す
        </button>
      </span>
    </div>
  );
}
