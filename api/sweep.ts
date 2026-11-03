import { errorMessage, isScheduler, json } from '../src/http.js'
import { sweep } from '../src/seller.js'

/** Deliver every funded job assigned to this agent. Scheduler only: it sends transactions. */
async function run(req: Request): Promise<Response> {
  if (!isScheduler(req)) return json({ error: 'unauthorised' }, 401)
  try {
    return json({ delivered: await sweep() })
  } catch (e: unknown) {
    return json({ error: errorMessage(e) }, 500)
  }
}

export const GET = run
export const POST = run
