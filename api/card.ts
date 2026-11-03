import { agentCard } from '../src/a2a.js'
import { json, preflight } from '../src/http.js'

export function GET(): Response {
  return json(agentCard())
}

export const OPTIONS = preflight
