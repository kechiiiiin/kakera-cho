// ビルド後の後始末。
//
// ⚠️ dist/ をまるごと assets として配るので、そのままだと dist/_worker.js（サーバ側のコード）まで
// 公開されてしまう。wrangler が警告を出す状態なので、.assetsignore を必ず置く。
// （Access の裏とはいえ、サーバのコードを配る理由がない）

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;

writeFileSync(join(dist, '.assetsignore'), ['_worker.js', '_routes.json', ''].join('\n'), 'utf8');

console.log('[postbuild] dist/.assetsignore を置きました（_worker.js を公開しない）');
