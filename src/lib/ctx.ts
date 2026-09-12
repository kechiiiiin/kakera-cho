// API ルートから env と waitUntil を取り出す。
// middleware で fail-closed にしてあるが、設定不備や除外パスの追加で穴が開かないよう
// 各ハンドラの冒頭でも locals.user を見る（多層防御・blog-cms と同じ流儀）。

import { ApiError } from './http';

export interface Ctx {
  env: Env;
  /** 控えへの書き出しなど、レスポンスを待たせない仕事を裏に回す */
  waitUntil: (p: Promise<unknown>) => void;
  user: { email: string };
}

export function ctxOf(locals: App.Locals): Ctx {
  if (!locals.user) throw new ApiError(401, 'Unauthorized');
  const runtime = locals.runtime;
  const env = runtime?.env as Env | undefined;
  if (!env?.DB) throw new ApiError(500, 'D1 のバインディング DB がありません');
  const waitUntil = (p: Promise<unknown>) => {
    const guarded = p.catch((e) => console.error('[kakera-cho:background]', e));
    if (runtime?.ctx?.waitUntil) runtime.ctx.waitUntil(guarded);
  };
  return { env, waitUntil, user: locals.user };
}
