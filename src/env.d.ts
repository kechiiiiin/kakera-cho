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

  /** 関所（sekisho・Access の JWT を検証する認証 Worker）への Service Binding。未設定なら全員 401 */
  SEKISHO?: import('./lib/auth/sekisho').Sekisho;

  // secrets
  BLOG_GITHUB_TOKEN?: string;
  DATA_GITHUB_TOKEN?: string;
  /** Access アプリの Application Audience (AUD) タグ。関所に渡す */
  CF_ACCESS_AUD?: string;

  // ローカル開発だけ。本番ビルドでは middleware の分岐ごと消える
  DEV_BYPASS_AUTH?: string;
}

declare namespace App {
  interface Locals extends Runtime {
    user?: { email: string };
  }
}
