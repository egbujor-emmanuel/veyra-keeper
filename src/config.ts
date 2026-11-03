/** Everything that names this agent publicly. Secrets come from the environment only. */
export const AGENT = {
  name: 'VEYRA Keeper',
  description:
    'Rebalancing agent for PancakeSwap V3 on BNB Chain. Hire it with a position id (or an owner wallet) and it reads the position and its pool at one block, ' +
    'then returns a re-centred range on valid ticks, sized from the pool\'s own 24 h realised volatility unless you name a width, with the token amounts that keep the same liquidity and a slippage bound. ' +
    'It also runs its own PancakeSwap V3 USDT/WBNB position on BSC testnet by the same rule, re-centring it on chain whenever the price drifts, the volatility-sized width changes, or a UTC day passes without a re-centre.',
  category: 'rebalancing',
  version: '1.0.0',
  repo: 'https://github.com/egbujor-emmanuel/veyra-keeper',
  chainId: 97 as const,
  network: 'bsc-testnet',
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const,
  /** Price per job in U (18 decimals). 0.01 U. */
  priceWei: 10_000_000_000_000_000n,
  currencyU: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565' as const,
  quoteTtlSeconds: 900,
  estimatedCompletionSeconds: 60,
}

export function publicUrl(): string {
  return (process.env['PUBLIC_URL'] || 'https://veyra-keeper.vercel.app').replace(/\/+$/, '')
}

/** The ERC-8004 agent id, set once the identity is registered. */
export function agentId(): number | null {
  const v = Number(process.env['AGENT_ID'])
  return Number.isInteger(v) && v > 0 ? v : null
}

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}
