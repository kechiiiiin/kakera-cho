/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  DB: D1Database;
  /** 非公開。かけらに貼った写真の原本 */
  PHOTOS: R2Bucket;
  /** 公開（images.kechiiiiin.com）。日記に出すときだけコピーする */
  IMAGES: R2Bucket;

  // [vars]（秘密ではない）
  BLOG_REPO: string;
  DATA_REPO: string;
  GITHUB_OWNER: string;

  // secrets
  BLOG_GITHUB_TOKEN?: string;
  DATA_GITHUB_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;

  // ローカル開発だけ。本番ビルドでは middleware の分岐ごと消える
  DEV_BYPASS_AUTH?: string;
}

declare namespace App {
  interface Locals extends Runtime {
    user?: { email: string };
  }
}
