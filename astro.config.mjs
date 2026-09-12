import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import preact from '@astrojs/preact';

// かけら帳は認証の裏の書き物道具なので SSR（API も同じ Worker に載せる）。
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // astro dev でも .dev.vars と D1/R2 のローカル実体を locals.runtime.env に流し込む
    platformProxy: { enabled: true },
  }),
  integrations: [preact()],
  devToolbar: { enabled: false },
});
