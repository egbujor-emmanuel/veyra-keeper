import { randomUUID } from 'node:crypto'
import { AGENT, agentId, publicUrl } from './config.js'
import { reader } from './chain.js'
import { parseRequest, resolveRequest } from './request.js'
import { analyse } from './strategy.js'
import { deliver, negotiate, parseJobId, verify } from './seller.js'

type Json = Record<string, unknown>
interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }
interface Part { kind?: string; type?: string; text?: string; data?: Json }

/** Hands work to the platform to finish after the response is sent (Vercel's waitUntil). */
export type Background = (work: Promise<unknown>) => void

export function agentCard(): Json {
  const base = publicUrl()
  return {
    name: AGENT.name,
    description: AGENT.description,
    url: `${base}/a2a`,
    version: AGENT.version,
    protocolVersion: '0.3.0',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'VEYRA', url: AGENT.repo },
    documentationUrl: AGENT.repo,
    category: AGENT.category,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'rebalance',
        name: 'PancakeSwap V3 range re-centre',
        description: 'Send a position NFT id (or the owner wallet), optionally a width such as ±8% and a block. Returns the current tick, whether it is in range, the distance to the nearer bound, a re-centred range on valid ticks (volatility-sized when no width is given), the token amounts for the same liquidity, and a slippage bound. Read-only: it never touches your wallet.',
        tags: ['rebalancing', 'pancakeswap', 'v3', 'liquidity', 'concentrated-liquidity', 'bnb-chain'],
        examples: ['Re-centre PancakeSwap V3 position 7683201 at ±6%', '{"tokenId":"7683201","rangePct":6,"chainId":56}'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'negotiate',
        name: 'Negotiate an ERC-8183 job',
        description: 'Data part {"skill":"negotiate","task_description":"...","terms":{...}} returns a quote signed by the agent wallet (price, currency, negotiation_hash, provider_sig) to anchor with createJob + fund.',
        tags: ['erc8183', 'negotiation', 'bnb-chain'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'notify_funded',
        name: 'Request delivery of a funded job',
        description: 'Data part {"skill":"notify_funded","job_id":<int>}. The agent checks the job carries its signed quote, answers at once, then submits the report hash on chain.',
        tags: ['erc8183', 'delivery', 'bnb-chain'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    ...(agentId() ? { erc8004: { agentId: agentId(), chainId: AGENT.chainId, registry: AGENT.identityRegistry } } : {}),
  }
}

export function registrationFile(): Json {
  const id = agentId()
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: AGENT.name,
    description: AGENT.description,
    image: `${publicUrl()}/logo.svg`,
    services: [
      { name: 'A2A', endpoint: `${publicUrl()}/.well-known/agent-card.json`, version: '0.3.0' },
      { name: 'web', endpoint: publicUrl() },
    ],
    category: AGENT.category,
    x402Support: false,
    active: true,
    registrations: id ? [{ agentId: id, agentRegistry: `eip155:${AGENT.chainId}:${AGENT.identityRegistry}` }] : [],
    supportedTrust: ['reputation'],
  }
}

/** One JSON-RPC call to the A2A endpoint. Never throws: faults become JSON-RPC errors. */
export async function handleRpc(body: unknown, background: Background): Promise<Json> {
  const req = (body ?? {}) as RpcRequest
  const id = req.id ?? null
  try {
    if (req.method === 'message/send') {
      const message = (req.params?.['message'] ?? {}) as { parts?: Part[]; contextId?: string; taskId?: string }
      const data = await dispatch(message.parts ?? [], background)
      // Prompt-style callers (Marque's Standard) read strict JSON from a text part; skill callers read the data part.
      const parts = [{ kind: 'text', text: JSON.stringify(data) }, { kind: 'data', data }]
      return { jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', messageId: randomUUID(), parts, ...(message.contextId ? { contextId: message.contextId } : {}) } }
    }
    if (req.method === 'agent/getAuthenticatedExtendedCard' || req.method === 'agent/getCard') return { jsonrpc: '2.0', id, result: agentCard() }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${String(req.method)}` } }
  } catch (e: unknown) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }
  }
}

async function dispatch(parts: Part[], background: Background): Promise<Json> {
  const dataPart = parts.find((p) => (p.kind ?? p.type) === 'data' && p.data)?.data
  const text = parts.filter((p) => (p.kind ?? p.type) === 'text').map((p) => p.text ?? '').join('\n')
  let data: Json | undefined = dataPart
  if (!data && text.trim().startsWith('{')) {
    try { data = JSON.parse(text) as Json } catch { /* plain text */ }
  }
  const skill = data?.['skill']
  if (skill === 'negotiate') return negotiate(data!)
  if (skill === 'notify_funded') return notifyFunded(data!, background)
  return preview(data ?? text)
}

async function notifyFunded(data: Json, background: Background): Promise<Json> {
  let jobId: number
  try {
    jobId = parseJobId(data['job_id'])
  } catch {
    return { status: 'rejected', error: `invalid job_id: ${JSON.stringify(data['job_id'])}` }
  }
  const v = await verify(jobId)
  if (!v.ok && v.permanent) return { status: 'rejected', job_id: jobId, reason: v.reason }
  background(deliver(jobId).catch(() => undefined))
  return { status: 'accepted', job_id: jobId, note: 'delivery started; the report hash is submitted on chain (read the job until SUBMITTED)' }
}

/** A read-only answer to a plain task: the same analysis a paid job delivers, at no charge. */
async function preview(input: unknown): Promise<Json> {
  const resolved = await resolveRequest(parseRequest(input))
  if (!resolved) {
    return { agent: AGENT.name, category: AGENT.category, skills: ['rebalance', 'negotiate', 'notify_funded'], help: 'Send a PancakeSwap V3 position NFT id (or its owner wallet), optionally a width like ±8% and a block number. Hire through ERC-8183 for an on-chain delivery.' }
  }
  const report = await analyse(resolved.task, reader(resolved.task.blockNumber, resolved.chainId))
  return resolved.note ? { ...report, assumptions: [resolved.note, ...report.assumptions] } : { ...report }
}
