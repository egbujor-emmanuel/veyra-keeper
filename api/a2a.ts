import { waitUntil } from '@vercel/functions'
import { agentCard, handleRpc } from '../src/a2a.js'
import { json, preflight } from '../src/http.js'

export function GET(): Response {
  return json(agentCard())
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  console.info('a2a request', JSON.stringify(body).slice(0, 3000))
  const out = await handleRpc(body, waitUntil)
  console.info('a2a response', JSON.stringify(out).slice(0, 1500))
  return json(out)
}

export const OPTIONS = preflight
