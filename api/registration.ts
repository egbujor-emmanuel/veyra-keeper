import { registrationFile } from '../src/a2a.js'
import { json, preflight } from '../src/http.js'

export function GET(): Response {
  return json(registrationFile())
}

export const OPTIONS = preflight
