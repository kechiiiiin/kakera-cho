// k-editor の往復検査: かけらの本文を「Markdown → エディタの文書 → Markdown」に通して、1 文字も変わらないかを見る。
//
//   npx wrangler d1 execute kakera --remote --json --command "SELECT id, body FROM kakera" > "$TMPDIR/kakera-bodies.json"
//   node scripts/check-roundtrip.mjs "$TMPDIR/kakera-bodies.json"
//
// ⚠️ 本文には家族の実名が入る。取った JSON は $TMPDIR にだけ置き、リポジトリに入れない。
//    このスクリプトは本文を表示しない（id と、どの規則で素の文字に倒れたかだけを出す）。
// 入力は wrangler の --json の形（[{ results: [{ id, body }] }]）か、[{ id, body }] の配列。
// 判定はエディタと同じ isBlockUrl（src/components/Editor.tsx）を使う。Node 22.6 以上（.ts を型を剥がして読む）。
import { readFileSync } from 'node:fs';
import { parseMarkdown, serializeMarkdown } from 'k-editor/markdown';
import { isSafeHref, matchBareUrl } from '../src/lib/markdown.ts';

const file = process.argv[2];
if (!file) {
  console.error('使い方: node scripts/check-roundtrip.mjs <本文の JSON>');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
/** @type {{ id: string; body: string }[]} */
const rows = Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && raw[0] && 'results' in raw[0]
  ? raw.flatMap((r) => r.results)
  : raw;

const isBlockUrl = (line) => isSafeHref(line) && matchBareUrl(line, 0)?.url === line;

let ng = 0;
const ruleCount = new Map();
for (const row of rows) {
  const rules = [];
  const doc = parseMarkdown(row.body, { isBlockUrl, onFallback: (r) => rules.push(r) });
  const ok = serializeMarkdown(doc) === row.body;
  if (!ok) ng++;
  for (const r of new Set(rules)) ruleCount.set(r, (ruleCount.get(r) ?? 0) + 1);
  if (!ok || rules.length) console.log(`${ok ? 'ok ' : 'NG '} ${row.id}${rules.length ? `  素に倒した規則: ${[...new Set(rules)].join(', ')}` : ''}`);
}
console.log(`\n${rows.length} 件中 一致 ${rows.length - ng} 件・不一致 ${ng} 件`);
if (ruleCount.size) {
  console.log('素の文字に倒した（見た目が素朴になる・文字は変わらない）規則と件数:');
  for (const [r, c] of ruleCount) console.log(`  ${r}: ${c} 件`);
}
process.exit(ng ? 1 : 0);
