import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { NameEntry } from '../lib/names/replace';
import { buildRealShape, resolveShape } from '../lib/names/doc';
import { api } from './api';
import { renderSpan, type MarkRender } from './NameMarks';

/**
 * 名前の辞書（公開名変換）。日記タブの隅から入る。
 *  追加・変更・削除（削除は二度押し）・例外のチェック。
 *  例外は「自分自身へ置き換える項目」として同じ表に持つ（別の仕組みを作らない）。
 *
 * ⚠️ 辞書は D1 にだけ置く（public のリポジトリに書かない）。
 */

interface Draft {
  source: string;
  target: string;
  exception: boolean;
}

const EMPTY: Draft = { source: '', target: '', exception: false };

function isException(e: NameEntry): boolean {
  return e.source === e.target;
}

export function NameMapScreen({ onBack, say }: { onBack: () => void; say: (msg: string) => void }): JSX.Element {
  const [entries, setEntries] = useState<NameEntry[] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY);
  const [arm, setArm] = useState(false);
  const [add, setAdd] = useState<Draft>(EMPTY);
  const [tryText, setTryText] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setEntries(await api.nameMap());
  }

  useEffect(() => {
    reload().catch((e: unknown) => say(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 画面の側でも最低限は確かめる（サーバでも同じことを確かめる）。 */
  function checkDraft(d: Draft, id: string | null): boolean {
    const source = d.source.trim();
    if (!source) {
      say('置き換え元を入れてください');
      return false;
    }
    if (!d.exception && !d.target.trim()) {
      say('置き換え先を入れてください（置き換えないなら例外に）');
      return false;
    }
    if ((entries ?? []).some((e) => e.source === source && e.id !== id)) {
      say(`「${source}」はもう辞書にあります`);
      return false;
    }
    return true;
  }

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openEdit(e: NameEntry): void {
    setEditId(e.id);
    setArm(false);
    setEdit({ source: e.source, target: isException(e) ? '' : e.target, exception: isException(e) });
  }

  function row(e: NameEntry): JSX.Element {
    const exc = isException(e);
    if (editId === e.id) {
      return (
        <div class="dict-row editing" key={e.id}>
          <div class="d-cap">
            <span>置き換え元</span>
            <span>→</span>
            <span>置き換え先</span>
          </div>
          <div class="d-grid">
            <input
              class="d-in"
              type="text"
              aria-label="置き換え元"
              value={edit.source}
              onInput={(ev) => setEdit({ ...edit, source: ev.currentTarget.value })}
            />
            <span class="d-arrow">→</span>
            <input
              class="d-in"
              type="text"
              aria-label="置き換え先"
              value={edit.exception ? '' : edit.target}
              disabled={edit.exception}
              placeholder={edit.exception ? 'そのまま' : ''}
              onInput={(ev) => setEdit({ ...edit, target: ev.currentTarget.value })}
            />
          </div>
          <label class="d-check">
            <input
              type="checkbox"
              checked={edit.exception}
              onChange={(ev) => setEdit({ ...edit, exception: ev.currentTarget.checked, target: '' })}
            />{' '}
            例外（置き換えずにそのまま出す）
          </label>
          <div class="d-actions">
            <button
              type="button"
              class="btn-primary"
              disabled={busy}
              onClick={() => {
                if (!checkDraft(edit, e.id)) return;
                void run(async () => {
                  await api.updateNameEntry(e.id, {
                    source: edit.source.trim(),
                    target: edit.target.trim(),
                    exception: edit.exception,
                  });
                  await reload();
                  setEditId(null);
                  say('辞書を直しました。次に組み直した日記から効きます');
                });
              }}
            >
              保存
            </button>
            <button type="button" class="btn-ghost" onClick={() => setEditId(null)}>
              やめる
            </button>
            <button
              type="button"
              class="btn-danger d-del"
              disabled={busy}
              onClick={() => {
                if (!arm) {
                  setArm(true);
                  return;
                }
                void run(async () => {
                  await api.deleteNameEntry(e.id);
                  await reload();
                  setEditId(null);
                  setArm(false);
                  say('消しました。辞書どおりだった箇所は実名に戻り、手で直した言葉は残ります');
                });
              }}
            >
              {arm ? '本当に消す' : '消す'}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        class="dict-row"
        key={e.id}
        role="button"
        tabIndex={0}
        onClick={() => openEdit(e)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openEdit(e);
          }
        }}
      >
        <span class="d-src">{e.source}</span>
        <span class="d-arrow">→</span>
        <span class={'d-tgt' + (exc ? ' d-same' : '')}>{exc ? 'そのまま' : e.target}</span>
        <span class="d-chev">›</span>
      </div>
    );
  }

  const list = entries ?? [];
  const rep = list.filter((e) => !isException(e));
  const exc = list.filter(isException);

  // 試し書き: 変換ページと同じく、記号にしてから辞書どおりに解く（押せない印）
  let trySeq = 0;
  const tryResolved = resolveShape(
    buildRealShape(tryText, list, () => `try${++trySeq}`),
    list
  );
  const tryRender: MarkRender = {
    text: tryResolved.text,
    marks: tryResolved.spans,
    keyOf: (m) => m.id,
  };

  return (
    <section>
      <div class="back-row">
        <button type="button" class="back-btn" onClick={onBack}>
          ‹ 日記へ戻る
        </button>
      </div>
      <p class="page-date" style="font-size:17px;">
        名前の辞書
      </p>
      <p class="page-sub">
        日記に書き出すときだけ、左の言葉を右に置き換えます。かけらは変わりません。
        <b class="page-sub-strong">長い語から先に当てる</b>
        ので、例外に足した語の中にある短い名前には当たりません。
      </p>

      {!entries ? (
        <p class="empty-note">読み込んでいます</p>
      ) : (
        <>
          <div class="section-head">
            <h2>置き換え（{rep.length}）</h2>
          </div>
          <div class="dict-list">{rep.length ? rep.map(row) : <p class="empty-note">ありません</p>}</div>

          <div class="section-head">
            <h2>例外・置き換えない（{exc.length}）</h2>
          </div>
          <div class="dict-list">{exc.length ? exc.map(row) : <p class="empty-note">ありません</p>}</div>
        </>
      )}

      <div class="section-head">
        <h2>足す</h2>
      </div>
      <div class="d-cap">
        <span>置き換え元</span>
        <span>→</span>
        <span>置き換え先</span>
      </div>
      <div class="d-grid">
        <input
          class="d-in"
          type="text"
          aria-label="置き換え元"
          value={add.source}
          onInput={(ev) => setAdd({ ...add, source: ev.currentTarget.value })}
        />
        <span class="d-arrow">→</span>
        <input
          class="d-in"
          type="text"
          aria-label="置き換え先"
          value={add.exception ? '' : add.target}
          disabled={add.exception}
          placeholder={add.exception ? 'そのまま' : ''}
          onInput={(ev) => setAdd({ ...add, target: ev.currentTarget.value })}
        />
      </div>
      <label class="d-check">
        <input
          type="checkbox"
          checked={add.exception}
          onChange={(ev) => setAdd({ ...add, exception: ev.currentTarget.checked, target: '' })}
        />{' '}
        例外（置き換えずにそのまま出す）
      </label>
      <div class="d-actions">
        <button
          type="button"
          class="btn-ghost"
          disabled={busy || !entries}
          onClick={() => {
            if (!checkDraft(add, null)) return;
            void run(async () => {
              await api.addNameEntry({ source: add.source.trim(), target: add.target.trim(), exception: add.exception });
              await reload();
              setAdd(EMPTY);
              say('辞書に足しました');
            });
          }}
        >
          辞書に足す
        </button>
      </div>

      <div class="section-head">
        <h2>試し書き</h2>
      </div>
      <input
        class="d-in"
        type="text"
        aria-label="試し書き"
        placeholder="ここに書くと、置き換えた結果が下に出ます"
        value={tryText}
        onInput={(ev) => setTryText(ev.currentTarget.value)}
      />
      <p class="try-out">
        {tryText ? renderSpan(tryRender, 0, tryRender.text.length) : <span class="try-empty">（ここに結果が出ます）</span>}
      </p>
      <p class="form-note export-note">
        辞書はかけら帳のデータベースにだけ置きます（リポジトリには書きません）。直すと、次に組み直した日記から効きます。
      </p>
    </section>
  );
}
