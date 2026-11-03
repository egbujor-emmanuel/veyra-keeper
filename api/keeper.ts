import { errorMessage, isScheduler, json } from '../src/http.js'
import { tick } from '../src/keeper.js'

/** Public GET is a dry run (the decision only). The scheduler's authorised call acts on chain. */
async function run(req: Request): Promise<Response> {
  try {
    return json(await tick({ dryRun: !isScheduler(req) }))
  } catch (e: unknown) {
    return json({ error: errorMessage(e) }, 500)
  }
}

export const GET = run
export const POST = run
