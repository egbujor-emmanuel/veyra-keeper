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
  return json(await handleRpc(body, waitUntil))
}

export const OPTIONS = preflight
