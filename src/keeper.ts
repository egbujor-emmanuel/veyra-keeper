import { list } from '@vercel/blob'
import { createWalletClient, encodeFunctionData, http, maxUint256, maxUint128, parseAbi, parseEther, type Hex } from 'viem'
import { bscTestnet } from 'viem/chains'
import { abis, PANCAKE, reader } from './chain.js'
import { poolVolatility, snap } from './strategy.js'
import { putJson } from './storage.js'
import type { Task } from './task.js'
import { agentAccount } from './wallet.js'

/**
 * VEYRA Keeper's own position: USDT/WBNB 0.25% on BSC testnet, sized from the real BNB market.
 *
 * The width comes from mainnet PancakeSwap USDT/WBNB's 24 h realised volatility (the testnet pool
 * barely trades, so its own oracle would size a range from noise). The position is re-centred when:
 *   - the price leaves the range,
 *   - the centre drifts more than a third of the half-width from the price,
 *   - the volatility-sized width moves more than 20% from the width in place, or
 *   - a UTC day has passed without a re-centre (a standing daily re-centre).
 * At most MAX_REBALANCES_PER_DAY per UTC day, whatever the triggers say.
 */
const T = {
  pool: '0x270E1420eFc26e4945113730a4c3D5cfF58A73ea',
  usdt: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
  wbnb: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
  swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
  quoter: '0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2',
} as const
const FEE = 2500
const MAINNET = { usdt: '0x55d398326f99059fF775485246999027B3197955', wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', fee: 500 } as const
const LN_TICK = Math.log(1.0001)
const DRIFT_FRACTION = 1 / 3
const WIDTH_CHANGE = 0.2
const MAX_REBALANCES_PER_DAY = 3
/** tBNB put to work when the keeper opens its first position: half wrapped, half swapped to USDT. */
const SEED_TBNB = parseEther('0.004')
/** If either side falls below this share of the position's value, swap toward 50/50 before minting. */
const MIN_SIDE_SHARE = 0.3
const SLIPPAGE_BPS = 100n
const LOG_PATH = 'keeper/actions.json'

const npmAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256, uint256)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256, uint256)',
  'function burn(uint256) payable',
  'function multicall(bytes[]) payable returns (bytes[])',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)', 'function approve(address, uint256) returns (bool)'])
const wbnbAbi = parseAbi(['function deposit() payable'])
const routerAbi = parseAbi(['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)'])
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256, uint160, uint32, uint256)'])

export interface ActionTx { label: string; hash: Hex }
export interface ActionEntry { day: string; at: string; kind: 'open' | 'rebalance'; reason: string; poolTick: number; targetPct: number; tickLower: number; tickUpper: number; tokenId: string; closedTokenId?: string; txs: ActionTx[] }
export interface Decision { act: boolean; reason: string; targetPct: number; poolTick: number; position: OwnPosition | null; actedToday: number }
interface OwnPosition { tokenId: bigint; tickLower: number; tickUpper: number; liquidity: bigint }

const testnet = () => reader(undefined, 97)
const today = () => new Date().toISOString().slice(0, 10)
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)

/** The keeper's live position in its pool, if it holds one. */
async function ownPosition(owner: `0x${string}`): Promise<OwnPosition | null> {
  const { client } = testnet()
  const npm = PANCAKE[97].positionManager
  const n = await client.readContract({ address: npm, abi: npmAbi, functionName: 'balanceOf', args: [owner] })
  for (let i = Number(n) - 1; i >= 0; i--) {
    const id = await client.readContract({ address: npm, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })
    const p = await client.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [id] })
    if (p[7] > 0n && p[4] === FEE && p[2].toLowerCase() === T.usdt.toLowerCase() && p[3].toLowerCase() === T.wbnb.toLowerCase()) {
      return { tokenId: id, tickLower: p[5], tickUpper: p[6], liquidity: p[7] }
    }
  }
  return null
}

/** The keeper's own position as an analysable task (the deliverable's fallback subject). */
export async function keeperPositionTask(): Promise<Task | null> {
  const pos = await ownPosition(agentAccount().address).catch(() => null)
  return pos ? { owner: agentAccount().address, tokenId: pos.tokenId.toString(), rangePct: 0 } : null
}

export async function readLog(): Promise<ActionEntry[]> {
  try {
    const { blobs } = await list({ prefix: LOG_PATH, limit: 1 })
    const url = blobs[0]?.url
    if (!url) return []
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })
    return r.ok ? ((await r.json()) as ActionEntry[]) : []
  } catch {
    return []
  }
}

async function targetRangePct(): Promise<number> {
  const main = reader(undefined, 56)
  const pool = await main.client.readContract({ address: PANCAKE[56].factory, abi: abis.factory, functionName: 'getPool', args: [MAINNET.usdt, MAINNET.wbnb, MAINNET.fee] })
  return (await poolVolatility(pool, main)).rangePct
}

export async function decide(log: ActionEntry[]): Promise<Decision> {
  const { client } = testnet()
  const owner = agentAccount().address
  const [slot0, position, targetPct] = await Promise.all([
    client.readContract({ address: T.pool, abi: abis.pool, functionName: 'slot0' }),
    ownPosition(owner),
    targetRangePct(),
  ])
  const poolTick = slot0[1]
  const actedToday = log.filter((e) => e.day === today()).length
  const base = { targetPct, poolTick, position, actedToday }
  if (actedToday >= MAX_REBALANCES_PER_DAY) return { ...base, act: false, reason: `already re-centred ${actedToday} times today (cap ${MAX_REBALANCES_PER_DAY})` }
  if (!position) return { ...base, act: true, reason: 'no position held: open one' }
  if (poolTick < position.tickLower || poolTick >= position.tickUpper) return { ...base, act: true, reason: `price left the range (tick ${poolTick} outside ${position.tickLower}..${position.tickUpper})` }
  const half = (position.tickUpper - position.tickLower) / 2
  const centre = position.tickLower + half
  if (Math.abs(poolTick - centre) > half * DRIFT_FRACTION) return { ...base, act: true, reason: `centre drifted ${Math.abs(poolTick - centre)} ticks, over a third of the ${half}-tick half-width` }
  const currentPct = (Math.exp(half * LN_TICK) - 1) * 100
  if (Math.abs(currentPct - targetPct) / targetPct > WIDTH_CHANGE) return { ...base, act: true, reason: `volatility-sized width is ±${targetPct}%, the range in place is ±${currentPct.toFixed(2)}%` }
  if (actedToday === 0) return { ...base, act: true, reason: `standing daily re-centre (no re-centre yet on ${today()})` }
  return { ...base, act: false, reason: 'in range, centred and correctly sized' }
}

/** Run one keeper cycle: decide, and if the rule says so, re-centre on chain. */
export async function tick(opts: { dryRun?: boolean } = {}): Promise<{ decision: Decision; action?: ActionEntry }> {
  const log = await readLog()
  const decision = await decide(log)
  if (!decision.act || opts.dryRun) return { decision }
  const action = await recentre(decision)
  await putJson(LOG_PATH, [...log, action].slice(-200))
  return { decision, action }
}

async function recentre(d: Decision): Promise<ActionEntry> {
  const account = agentAccount()
  const { client } = testnet()
  if ((await client.getChainId()) !== 97) throw new Error('keeper runs on BSC testnet only')
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(process.env['BSC_TESTNET_RPC_URL'] || 'https://bsc-testnet-rpc.publicnode.com') })
  const txs: ActionTx[] = []
  const send = async (label: string, hash: Promise<Hex>): Promise<void> => {
    const h = await hash
    const r = await client.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') throw new Error(`${label} reverted: ${h}`)
    txs.push({ label, hash: h })
  }
  const npm = PANCAKE[97].positionManager

  if (d.position) {
    const id = d.position.tokenId
    const calls = [
      encodeFunctionData({ abi: npmAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: id, liquidity: d.position.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() }] }),
      encodeFunctionData({ abi: npmAbi, functionName: 'collect', args: [{ tokenId: id, recipient: account.address, amount0Max: maxUint128, amount1Max: maxUint128 }] }),
      encodeFunctionData({ abi: npmAbi, functionName: 'burn', args: [id] }),
    ]
    await send(`Close position #${id}`, wallet.writeContract({ address: npm, abi: npmAbi, functionName: 'multicall', args: [calls] }))
  } else {
    const half = SEED_TBNB / 2n
    await send('Wrap tBNB to WBNB', wallet.writeContract({ address: T.wbnb, abi: wbnbAbi, functionName: 'deposit', value: half }))
    const { result: q } = await client.simulateContract({ address: T.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: T.wbnb, tokenOut: T.usdt, amountIn: half, fee: FEE, sqrtPriceLimitX96: 0n }] })
    await send('Swap tBNB to USDT', wallet.writeContract({ address: T.swapRouter, abi: routerAbi, functionName: 'exactInputSingle', value: half,
      args: [{ tokenIn: T.wbnb, tokenOut: T.usdt, fee: FEE, recipient: account.address, deadline: deadline(), amountIn: half, amountOutMinimum: (q[0] * (10_000n - SLIPPAGE_BPS)) / 10_000n, sqrtPriceLimitX96: 0n }] }))
  }

  await rebalanceInventory(account.address, wallet, send)
  for (const token of [T.usdt, T.wbnb]) {
    const allowance = await client.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [account.address, npm] })
    if (allowance < parseEther('1000')) await send('Approve position manager', wallet.writeContract({ address: token, abi: erc20, functionName: 'approve', args: [npm, maxUint256] }))
  }

  const [slot0, spacing, usdt, wbnb] = await Promise.all([
    client.readContract({ address: T.pool, abi: abis.pool, functionName: 'slot0' }),
    client.readContract({ address: T.pool, abi: abis.pool, functionName: 'tickSpacing' }),
    client.readContract({ address: T.usdt, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    client.readContract({ address: T.wbnb, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
  ])
  const halfTicks = Math.log(1 + d.targetPct / 100) / LN_TICK
  const tickLower = snap(slot0[1] - halfTicks, spacing)
  const tickUpper = Math.max(snap(slot0[1] + halfTicks, spacing), tickLower + spacing)
  const params = { token0: T.usdt, token1: T.wbnb, fee: FEE, tickLower, tickUpper, amount0Desired: usdt, amount1Desired: wbnb, amount0Min: 0n, amount1Min: 0n, recipient: account.address, deadline: deadline() }
  const { result } = await client.simulateContract({ account, address: npm, abi: npmAbi, functionName: 'mint', args: [params] })
  const withMins = { ...params, amount0Min: (result[2] * (10_000n - SLIPPAGE_BPS)) / 10_000n, amount1Min: (result[3] * (10_000n - SLIPPAGE_BPS)) / 10_000n }
  await send(`Open range ${tickLower}..${tickUpper}`, wallet.writeContract({ address: npm, abi: npmAbi, functionName: 'mint', args: [withMins] }))

  return {
    day: today(), at: new Date().toISOString(), kind: d.position ? 'rebalance' : 'open', reason: d.reason,
    poolTick: slot0[1], targetPct: d.targetPct, tickLower, tickUpper, tokenId: result[0].toString(),
    ...(d.position ? { closedTokenId: d.position.tokenId.toString() } : {}), txs,
  }
}

/** Swap toward an even split when one side has become too small to fill a centred range. */
async function rebalanceInventory(
  owner: `0x${string}`,
  wallet: ReturnType<typeof createWalletClient>,
  send: (label: string, hash: Promise<Hex>) => Promise<void>,
): Promise<void> {
  const { client } = testnet()
  const [slot0, usdt, wbnb] = await Promise.all([
    client.readContract({ address: T.pool, abi: abis.pool, functionName: 'slot0' }),
    client.readContract({ address: T.usdt, abi: erc20, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: T.wbnb, abi: erc20, functionName: 'balanceOf', args: [owner] }),
  ])
  const sqrtP = Number(slot0[0]) / 2 ** 96
  const usdtInWbnb = Number(usdt) * sqrtP * sqrtP
  const total = usdtInWbnb + Number(wbnb)
  if (total === 0) return
  const wbnbShare = Number(wbnb) / total
  if (wbnbShare >= MIN_SIDE_SHARE && wbnbShare <= 1 - MIN_SIDE_SHARE) return
  const sellWbnb = wbnbShare > 0.5
  const tokenIn = sellWbnb ? T.wbnb : T.usdt
  const tokenOut = sellWbnb ? T.usdt : T.wbnb
  const amountIn = sellWbnb ? BigInt(Math.floor((Number(wbnb) - total / 2))) : BigInt(Math.floor((Number(usdt) * (0.5 - wbnbShare)) / (1 - wbnbShare)))
  if (amountIn <= 0n) return
  const allowance = await client.readContract({ address: tokenIn, abi: erc20, functionName: 'allowance', args: [owner, T.swapRouter] })
  if (allowance < amountIn) await send('Approve router', wallet.writeContract({ account: wallet.account!, chain: bscTestnet, address: tokenIn, abi: erc20, functionName: 'approve', args: [T.swapRouter, maxUint256] }))
  const { result: q } = await client.simulateContract({ address: T.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }] })
  await send(`Rebalance inventory: swap ${sellWbnb ? 'WBNB to USDT' : 'USDT to WBNB'}`, wallet.writeContract({ account: wallet.account!, chain: bscTestnet, address: T.swapRouter, abi: routerAbi, functionName: 'exactInputSingle',
    args: [{ tokenIn, tokenOut, fee: FEE, recipient: owner, deadline: deadline(), amountIn, amountOutMinimum: (q[0] * (10_000n - SLIPPAGE_BPS)) / 10_000n, sqrtPriceLimitX96: 0n }] }))
}
