import { AGENT, agentId, publicUrl } from '../src/config.js'
import { errorMessage, json } from '../src/http.js'
import { readLog } from '../src/keeper.js'
import { agentAccount } from '../src/wallet.js'

export async function GET(): Promise<Response> {
  try {
    const actions = await readLog()
    const txCount = actions.reduce((n, a) => n + a.txs.length, 0)
    return json({
      agent: AGENT.name, category: AGENT.category, chainId: AGENT.chainId, agentId: agentId(),
      identityRegistry: AGENT.identityRegistry, wallet: agentAccount().address, card: `${publicUrl()}/.well-known/agent-card.json`,
      onchain: { transactions: txCount, days: [...new Set(actions.map((a) => a.day))] }, actions,
    })
  } catch (e: unknown) {
    return json({ error: errorMessage(e) }, 500)
  }
}
