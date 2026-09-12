// API の返し方をひとところに。画面は API を叩くだけの薄い層なので、形を揃えておく。

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function fail(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

/** 想定済みの業務エラー（そのまま HTTP ステータスに写す）。 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** ハンドラを包んで、投げられた ApiError を素直な JSON に落とす。 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message);
    const message = e instanceof Error ? e.message : String(e);
    console.error('[kakera-cho]', message);
    return fail(500, message);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'JSON として読めません');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'オブジェクトを送ってください');
  }
  return body as Record<string, unknown>;
}
