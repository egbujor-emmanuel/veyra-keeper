import { ERC8183Config, ERC8183JobOps, JobDescription, NegotiationHandler, RouterClient } from '@bnbagent/sdk/erc8183'
import { AGENT, publicUrl } from './config.js'
import { reader } from './chain.js'
import { parseRequest, resolveRequest } from './request.js'
import { BlobStorageProvider } from './storage.js'
import { analyse } from './strategy.js'
import { keeperPositionTask } from './keeper.js'
import { sdkWallet } from './wallet.js'

/** What the deliverable promises, stated in the quote so a buyer anchors it on chain. */
const DEFAULT_TERMS = {
  deliverables: 'JSON rebalancing report: currentTick, inRange, pctToNearestBound, proposedTickLower, proposedTickUpper, amount0, amount1, maxSlippageBps, blockNumber, assumptions.',
  quality_standards: 'Read from chain at one stated block. Ticks are multiples of the pool tickSpacing; amounts satisfy the V3 liquidity formula for the same liquidity (Marque MCS-REB-1).',
}

// The SDK's built-in bsc-testnet RPC no longer resolves; it reads this override lazily on first use.
process.env['RPC_URL_BSC_TESTNET'] ??= 'https://bsc-testnet-rpc.publicnode.com'

let opsPromise: Promise<ERC8183JobOps> | null = null

function jobOps(): Promise<ERC8183JobOps> {
  opsPromise ??= ERC8183JobOps.create({
    walletProvider: sdkWallet(),
    network: AGENT.network,
    storageProvider: new BlobStorageProvider(),
    servicePrice: AGENT.priceWei,
    agentUrl: `${publicUrl()}/erc8183`,
  }).catch((e: unknown) => {
    opsPromise = null
    throw e
  })
  return opsPromise
}

/** A signed quote at the fixed list price. Always quotes: a task it cannot place is answered at delivery, not refused here. */
export async function negotiate(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = data['request']
  const base = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { task_description: data['task_description'] ?? data['task'] ?? '', terms: data['terms'] }
  const terms = base['terms'] !== null && typeof base['terms'] === 'object' ? { ...DEFAULT_TERMS, ...(base['terms'] as Record<string, unknown>) } : DEFAULT_TERMS
  const request = { ...base, task_description: String(base['task_description'] ?? ''), terms }
  const network = new ERC8183Config({ network: AGENT.network })
  const handler = new NegotiationHandler({
    servicePrice: AGENT.priceWei.toString(),
    currency: AGENT.currencyU,
    estimatedCompletionSeconds: AGENT.estimatedCompletionSeconds,
    requireQualityStandards: false,
    walletProvider: sdkWallet(),
    quoteTtlSeconds: AGENT.quoteTtlSeconds,
    chainId: network.effectiveChainId,
    verifyingContract: network.effectiveCommerceAddress,
  })
  const result = await handler.negotiate(request, { price: AGENT.priceWei.toString(), estimatedCompletionSeconds: AGENT.estimatedCompletionSeconds })
  if (result.accepted && !result.providerSig) throw new Error('quote accepted without a provider signature; refusing to relay it')
  return result.toDict()
}

export interface Verdict { ok: boolean; reason: string; permanent: boolean }

/** Is this job funded, assigned to us, and carrying the quote we signed? */
export async function verify(jobId: number): Promise<Verdict> {
  const ops = await jobOps()
  const v = await ops.verifyJob(jobId)
  if (v.valid) return { ok: true, reason: 'funded', permanent: false }
  return { ok: false, reason: String(v.error ?? v.error_code ?? 'not deliverable'), permanent: v.retryable !== true }
}

/** The report for a buyer's task text, falling back to the keeper's own position when none can be placed. */
export async function buildDeliverable(taskText: string): Promise<Record<string, unknown>> {
  const resolved = await resolveRequest(parseRequest(taskText))
  if (resolved) {
    const report = await analyse(resolved.task, reader(resolved.task.blockNumber, resolved.chainId))
    return { ...report, assumptions: [...(resolved.note ? [resolved.note] : []), ...report.assumptions] }
  }
  const own = await keeperPositionTask()
  if (own) {
    const report = await analyse(own, reader(undefined, AGENT.chainId))
    return { ...report, assumptions: ['No PancakeSwap V3 position could be found from the task, so this reports on VEYRA Keeper\'s own testnet position. Send a position id (or the owner wallet) to have yours read.', ...report.assumptions] }
  }
  return { error: 'No PancakeSwap V3 position could be found from the task.', howToAsk: 'Send the position NFT id, or the wallet that owns it, and optionally a width such as ±8%.' }
}

/** Verify, work and submit one job on chain. Idempotent: a job that is no longer FUNDED is skipped. */
export async function deliver(jobId: number): Promise<Record<string, unknown>> {
  const v = await verify(jobId)
  if (!v.ok) return { ok: false, job_id: jobId, skip: v.permanent, reason: v.reason }
  const ops = await jobOps()
  const client = ops.erc8183Client
  if (!client) throw new Error('ERC-8183 client unavailable')
  const job = await client.getJob(BigInt(jobId))
  const spec = JobDescription.fromStr(job.description)
  const taskText = spec ? JSON.stringify({ task: spec.task, terms: spec.terms }) : job.description
  const report = await buildDeliverable(spec?.task ?? taskText)
  const res = await ops.submitResult(jobId, JSON.stringify(report), { job_id: jobId, generator: `${AGENT.name} ${AGENT.version}`, repo: AGENT.repo })
  if (!res.success) throw new Error(`submit(${jobId}) failed: ${String(res.error ?? res.error_code)}`)
  return { ok: true, job_id: jobId, tx_hash: res.txHash, deliverable_url: res['deliverableUrl'] }
}

/** Deliver every funded job assigned to this agent: the fallback for buyers who fund but never notify. */
export async function sweep(): Promise<Array<Record<string, unknown>>> {
  const ops = await jobOps()
  const pending = await ops.getPendingJobs()
  const jobs = Array.isArray(pending['jobs']) ? (pending['jobs'] as Array<Record<string, unknown>>) : []
  const results: Array<Record<string, unknown>> = []
  for (const j of jobs) {
    const id = Number(j['jobId'])
    if (!Number.isInteger(id)) continue
    try {
      results.push(await deliver(id))
    } catch (e: unknown) {
      results.push({ ok: false, job_id: id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return results
}

/**
 * Settle every delivered job whose review window has closed. Until someone calls settle, a delivered
 * job stays SUBMITTED and never completes; the router refuses (reverts) while the window is open,
 * so a refusal here just means "not yet".
 */
export async function settleDue(): Promise<Array<Record<string, unknown>>> {
  const ops = await jobOps()
  const submitted = await ops.getSubmittedJobs()
  const jobs = Array.isArray(submitted['jobs']) ? (submitted['jobs'] as Array<Record<string, unknown>>) : []
  if (jobs.length === 0) return []
  const network = new ERC8183Config({ network: AGENT.network })
  const router = new RouterClient(reader(undefined, AGENT.chainId).client, network.effectiveRouterAddress, sdkWallet())
  const results: Array<Record<string, unknown>> = []
  for (const j of jobs) {
    const id = Number(j['jobId'])
    if (!Number.isInteger(id)) continue
    try {
      const tx = await router.settle(BigInt(id))
      results.push({ ok: true, job_id: id, settle_tx: tx.transactionHash })
    } catch (e: unknown) {
      results.push({ ok: false, job_id: id, reason: (e instanceof Error ? e.message : String(e)).split('\n')[0] })
    }
  }
  return results
}

export function parseJobId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  return Number(BigInt(String(raw).trim()))
}
