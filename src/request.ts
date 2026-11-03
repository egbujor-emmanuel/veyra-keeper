import { parseAbi } from 'viem'
import { PANCAKE, reader } from './chain.js'
import type { Task } from './task.js'

/** What a buyer asked for, before the position is resolved on chain. */
export interface BuyerRequest {
  tokenId?: string
  owner?: `0x${string}`
  rangePct?: number
  feeTier?: number
  blockNumber?: bigint
  chainId?: 56 | 97
}

/** A request resolved to one position on one chain, ready for analyse(). */
export interface ResolvedTask { task: Task; chainId: 56 | 97; note?: string }

const enumerable = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128 liquidity, uint256, uint256, uint128, uint128)',
])
/** How many of an owner's positions to scan for one with liquidity. */
const MAX_POSITIONS_SCANNED = 20

/**
 * Read a buyer's task, structured or in plain words. Marketplaces send either a JSON object or the
 * prose their hire form produced, so both are accepted and nothing here throws.
 */
export function parseRequest(input: unknown): BuyerRequest {
  if (input !== null && typeof input === 'object') return fromObject(input as Record<string, unknown>)
  const text = String(input ?? '')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try { return fromObject(JSON.parse(trimmed) as Record<string, unknown>) } catch { /* fall through to prose */ }
  }
  return fromText(text)
}

function fromObject(o: Record<string, unknown>): BuyerRequest {
  const nested = (o['task'] ?? o['task_description'] ?? o['subject']) as unknown
  const base = typeof nested === 'string' || (nested && typeof nested === 'object') ? parseRequest(nested) : {}
  const id = o['tokenId'] ?? o['positionId'] ?? o['position'] ?? o['tokenID']
  const owner = o['owner'] ?? o['wallet'] ?? o['address']
  const range = o['rangePct'] ?? o['range_pct'] ?? o['range']
  const policy = (o['policy'] ?? {}) as Record<string, unknown>
  const chain = Number(o['chainId'] ?? o['chain_id'] ?? o['chain'])
  return {
    ...base,
    ...(id !== undefined && /^\d+$/.test(String(id)) ? { tokenId: String(id) } : {}),
    ...(typeof owner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(owner) ? { owner: owner as `0x${string}` } : {}),
    ...(Number(range ?? policy['rangePct']) > 0 ? { rangePct: Number(range ?? policy['rangePct']) } : {}),
    ...(Number(o['feeTier'] ?? policy['feeTier']) > 0 ? { feeTier: Number(o['feeTier'] ?? policy['feeTier']) } : {}),
    ...(/^\d+$/.test(String(o['blockNumber'] ?? '')) ? { blockNumber: BigInt(String(o['blockNumber'])) } : {}),
    ...(chain === 56 || chain === 97 ? { chainId: chain } : {}),
  }
}

function fromText(text: string): BuyerRequest {
  const owner = text.match(/0x[0-9a-fA-F]{40}/)?.[0] as `0x${string}` | undefined
  const tokenId = text.match(/(?:position(?:\s+nft)?(?:\s+id)?|token\s*id|nft\s*id|#)\s*[:#]?\s*#?\s*(\d{2,12})\b/i)?.[1]
  const pct = text.match(/±\s*([0-9]+(?:\.[0-9]+)?)\s*%|([0-9]+(?:\.[0-9]+)?)\s*%/)
  const rangePct = pct ? Number(pct[1] ?? pct[2]) : undefined
  const fee = text.match(/fee\s*tier\s*:?\s*(\d{3,5})/i)?.[1]
  const block = text.match(/block\s*(?:number)?\s*:?\s*(\d{6,12})/i)?.[1]
  const chainId: 56 | 97 | undefined = /testnet|chain\s*(?:id)?\s*:?\s*97\b/i.test(text) ? 97 : /chain\s*(?:id)?\s*:?\s*56\b|mainnet/i.test(text) ? 56 : undefined
  return {
    ...(tokenId ? { tokenId } : {}),
    ...(owner ? { owner } : {}),
    ...(rangePct && rangePct > 0 && rangePct < 100 ? { rangePct } : {}),
    ...(fee ? { feeTier: Number(fee) } : {}),
    ...(block ? { blockNumber: BigInt(block) } : {}),
    ...(chainId ? { chainId } : {}),
  }
}

/**
 * Pin a request to one position. A position id is looked up on the named chain, or mainnet then
 * testnet; an owner alone resolves to their first position that still holds liquidity.
 */
export async function resolveRequest(req: BuyerRequest): Promise<ResolvedTask | null> {
  const chains: Array<56 | 97> = req.chainId ? [req.chainId] : [56, 97]
  for (const chainId of chains) {
    const { client } = reader(undefined, chainId)
    const npm = PANCAKE[chainId].positionManager
    let tokenId = req.tokenId
    let note: string | undefined
    if (!tokenId && req.owner) {
      tokenId = await firstLivePosition(req.owner, chainId).catch(() => undefined)
      if (tokenId) note = `No position id given; used ${req.owner}'s first position with liquidity, #${tokenId}.`
    }
    if (!tokenId) continue
    try {
      await client.readContract({ address: npm, abi: enumerable, functionName: 'positions', args: [BigInt(tokenId)] })
    } catch {
      continue
    }
    const task: Task = {
      owner: req.owner ?? '0x0000000000000000000000000000000000000000',
      tokenId,
      rangePct: req.rangePct ?? 0,
      ...(req.feeTier ? { feeTier: req.feeTier } : {}),
      ...(req.blockNumber !== undefined ? { blockNumber: req.blockNumber } : {}),
    }
    return { task, chainId, ...(note ? { note } : {}) }
  }
  return null
}

async function firstLivePosition(owner: `0x${string}`, chainId: 56 | 97): Promise<string | undefined> {
  const { client } = reader(undefined, chainId)
  const npm = PANCAKE[chainId].positionManager
  const count = await client.readContract({ address: npm, abi: enumerable, functionName: 'balanceOf', args: [owner] })
  const n = Number(count < BigInt(MAX_POSITIONS_SCANNED) ? count : BigInt(MAX_POSITIONS_SCANNED))
  for (let i = n - 1; i >= 0; i--) {
    const id = await client.readContract({ address: npm, abi: enumerable, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })
    const pos = await client.readContract({ address: npm, abi: enumerable, functionName: 'positions', args: [id] })
    if (pos[7] > 0n) return id.toString()
  }
  return undefined
}
