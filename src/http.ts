/** Small shared helpers for the API routes. */

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' }

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

/** Scheduled callers (Vercel Cron, the GitHub workflow) present CRON_SECRET as a bearer token. */
export function isScheduler(req: Request): boolean {
  const secret = process.env['CRON_SECRET']
  return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
