import { abis, PANCAKE, type ChainReader } from './chain.js'
import type { Report, Task } from './task.js'

const LN_TICK = Math.log(1.0001)
const Q96 = 2 ** 96
/** Bounds on a volatility-sized half-width, in percent. Below 2% a range churns on noise; above 25% it barely earns. */
const MIN_RANGE_PCT = 2
const MAX_RANGE_PCT = 25
/** Used only when the pool's oracle cannot answer a 24 h window (too few observations recorded). */
const FALLBACK_RANGE_PCT = 8
/** Two daily standard deviations: wide enough that the price stays inside on most days. */
const SIGMA_MULTIPLE = 2
const HOURS = 24

export interface PositionState {
  token0: `0x${string}`
  token1: `0x${string}`
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  pool: `0x${string}`
  sqrtPriceX96: bigint
  tick: number
  tickSpacing: number
  decimals0: number
  decimals1: number
}

export interface Volatility { rangePct: number; dailySigmaPct: number | null; source: string }

/** Read a position and its pool at one block. Throws if the position does not exist on this chain. */
export async function readPosition(tokenId: bigint, chain: ChainReader): Promise<PositionState> {
  const at = chain.blockNumber === undefined ? {} : { blockNumber: chain.blockNumber }
  const { client } = chain
  const p = await client.readContract({ address: PANCAKE[chain.chainId].positionManager, abi: abis.positionManager, functionName: 'positions', args: [tokenId], ...at })
  const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p
  const pool = await client.readContract({ address: PANCAKE[chain.chainId].factory, abi: abis.factory, functionName: 'getPool', args: [token0, token1, fee], ...at })
  const [slot0, tickSpacing, decimals0, decimals1] = await Promise.all([
    client.readContract({ address: pool, abi: abis.pool, functionName: 'slot0', ...at }),
    client.readContract({ address: pool, abi: abis.pool, functionName: 'tickSpacing', ...at }),
    client.readContract({ address: token0, abi: abis.erc20, functionName: 'decimals', ...at }),
    client.readContract({ address: token1, abi: abis.erc20, functionName: 'decimals', ...at }),
  ])
  return { token0, token1, fee, tickLower, tickUpper, liquidity, pool, sqrtPriceX96: slot0[0], tick: slot0[1], tickSpacing, decimals0, decimals1 }
}

/**
 * VEYRA's range sizing: realised volatility from the pool's own oracle over the last 24 hours.
 * Hourly time-weighted ticks come from observe(); their changes give an hourly sigma, scaled to a day.
 */
export async function poolVolatility(pool: `0x${string}`, chain: ChainReader): Promise<Volatility> {
  const secondsAgos = Array.from({ length: HOURS + 1 }, (_, i) => (HOURS - i) * 3600)
  try {
    const [cumulatives] = await chain.client.readContract({
      address: pool, abi: abis.pool, functionName: 'observe', args: [secondsAgos],
      ...(chain.blockNumber === undefined ? {} : { blockNumber: chain.blockNumber }),
    })
    const hourlyTicks = cumulatives.slice(1).map((c, i) => Number(c - cumulatives[i]!) / 3600)
    return sized(hourlyTicks, 'pool oracle, 24 hourly TWAP ticks')
  } catch {
    // A pool that trades every block overwrites its oracle buffer in well under a day. Sample its
    // spot tick once an hour from archive state instead.
    try {
      return sized(await hourlySpotTicks(pool, chain), 'pool spot tick sampled hourly over 24 h (archive state)')
    } catch {
      return { rangePct: FALLBACK_RANGE_PCT, dailySigmaPct: null, source: 'neither the pool oracle nor archive state could answer a 24 h window' }
    }
  }
}

function sized(hourlyTicks: number[], source: string): Volatility {
  const moves = hourlyTicks.slice(1).map((t, i) => t - hourlyTicks[i]!)
  const mean = moves.reduce((a, b) => a + b, 0) / moves.length
  const variance = moves.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, moves.length - 1)
  const dailySigmaPct = Math.sqrt(variance) * LN_TICK * Math.sqrt(HOURS) * 100
  const rangePct = clamp(round(SIGMA_MULTIPLE * dailySigmaPct, 1), MIN_RANGE_PCT, MAX_RANGE_PCT)
  return { rangePct, dailySigmaPct: round(dailySigmaPct, 3), source }
}

/** The pool's spot tick at 25 blocks an hour apart, ending at the pinned block. */
async function hourlySpotTicks(pool: `0x${string}`, chain: ChainReader): Promise<number[]> {
  const head = await chain.client.getBlock(chain.blockNumber === undefined ? {} : { blockNumber: chain.blockNumber })
  const probe = await chain.client.getBlock({ blockNumber: head.number - 10_000n })
  const blocksPerHour = (10_000 * 3600) / Number(head.timestamp - probe.timestamp)
  const blocks = Array.from({ length: HOURS + 1 }, (_, i) => head.number - BigInt(Math.round((HOURS - i) * blocksPerHour)))
  const slots = await Promise.all(blocks.map((blockNumber) => chain.client.readContract({ address: pool, abi: abis.pool, functionName: 'slot0', blockNumber })))
  return slots.map((s) => s[1])
}

/** Answer a rebalancing task at the pinned block (or the latest one). */
export async function analyse(task: Task, chain: ChainReader): Promise<Report> {
  const blockNumber = chain.blockNumber ?? (await chain.client.getBlockNumber())
  const pinned: ChainReader = { ...chain, blockNumber }
  const s = await readPosition(BigInt(task.tokenId), pinned)
  const assumptions: string[] = [`Read on chain ${chain.chainId} at block ${blockNumber}; pool ${s.pool}, fee ${s.fee}, tickSpacing ${s.tickSpacing}.`]

  let rangePct = task.rangePct
  if (!(rangePct > 0)) {
    const vol = await poolVolatility(s.pool, pinned)
    rangePct = vol.rangePct
    assumptions.push(`No range given: sized at ±${rangePct}% from ${vol.source}` + (vol.dailySigmaPct === null ? '.' : ` (daily sigma ${vol.dailySigmaPct}%, ${SIGMA_MULTIPLE} sigma).`))
  }
  if (task.feeTier !== undefined && Number.isFinite(task.feeTier) && task.feeTier !== s.fee) {
    assumptions.push(`The task named fee tier ${task.feeTier}; the position sits on ${s.fee}, which is what this answer uses.`)
  }

  const sqrtP = Number(s.sqrtPriceX96) / Q96
  const price = sqrtP * sqrtP // raw token1 per raw token0
  const inRange = s.tickLower <= s.tick && s.tick < s.tickUpper
  const lowerGap = Math.abs(1 - tickPrice(s.tickLower) / price) * 100
  const upperGap = Math.abs(tickPrice(s.tickUpper) / price - 1) * 100
  const pctToNearestBound = round(Math.min(lowerGap, upperGap), 4)

  const proposedTickLower = snap(Math.log(price * (1 - rangePct / 100)) / LN_TICK, s.tickSpacing)
  let proposedTickUpper = snap(Math.log(price * (1 + rangePct / 100)) / LN_TICK, s.tickSpacing)
  if (proposedTickUpper <= proposedTickLower) proposedTickUpper = proposedTickLower + s.tickSpacing

  const [raw0, raw1] = amountsForLiquidity(Number(s.liquidity), sqrtP, proposedTickLower, proposedTickUpper)
  if (s.liquidity === 0n) assumptions.push('The position holds no liquidity, so both amounts are zero; supply a liquidity target to size a fresh mint.')
  assumptions.push(`Same liquidity (${s.liquidity}) re-centred at ±${rangePct}% around spot; ticks rounded to the nearest multiple of ${s.tickSpacing}.`)

  return {
    currentTick: s.tick,
    inRange,
    pctToNearestBound,
    proposedTickLower,
    proposedTickUpper,
    amount0: raw0 / 10 ** s.decimals0,
    amount1: raw1 / 10 ** s.decimals1,
    maxSlippageBps: slippageFor(s.fee),
    blockNumber: blockNumber.toString(),
    assumptions,
  }
}

/** V3 token amounts for liquidity L between two ticks at the current sqrt price (raw units). */
export function amountsForLiquidity(liquidity: number, sqrtP: number, tickLower: number, tickUpper: number): [number, number] {
  const sa = Math.sqrt(tickPrice(tickLower))
  const sb = Math.sqrt(tickPrice(tickUpper))
  if (sqrtP <= sa) return [(liquidity * (sb - sa)) / (sa * sb), 0]
  if (sqrtP >= sb) return [0, liquidity * (sb - sa)]
  return [(liquidity * (sb - sqrtP)) / (sqrtP * sb), liquidity * (sqrtP - sa)]
}

/** Slippage bound for the re-centre swap: the pool's own fee plus 30 bps of price movement while it lands. */
export function slippageFor(fee: number): number {
  return fee / 100 + 30
}

export function snap(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing
}

function tickPrice(tick: number): number {
  return Math.exp(tick * LN_TICK)
}

function round(x: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(x * f) / f
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}
