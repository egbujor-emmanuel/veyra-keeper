import { createPublicClient, fallback, http, parseAbi, type PublicClient } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'

/** Read-only clients. Nothing in this file holds a key or signs. */
export interface ChainReader { client: PublicClient; blockNumber?: bigint; chainId: 56 | 97 }

// PublicNode serves historical state on BSC mainnet, which the Standard's pinned-block cases need.
const RPC: Record<56 | 97, string> = {
  56: process.env['BSC_RPC_URL'] || 'https://bsc-rpc.publicnode.com',
  97: process.env['BSC_TESTNET_RPC_URL'] || 'https://bsc-testnet-rpc.publicnode.com',
}

// Tried in order when the primary refuses. PublicNode answers historical calls from most networks
// but 403s some datacenter ranges; Blast serves archive state on mainnet.
const FALLBACK_RPC: Record<56 | 97, string[]> = {
  56: ['https://bsc-mainnet.public.blastapi.io', 'https://bsc-dataseed.bnbchain.org'],
  97: ['https://bsc-testnet.public.blastapi.io', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
}

const clients = new Map<number, PublicClient>()

export function reader(blockNumber?: bigint, chainId: 56 | 97 = 56): ChainReader {
  let client = clients.get(chainId)
  if (!client) {
    const urls = [RPC[chainId], ...FALLBACK_RPC[chainId]]
    const transport = fallback(urls.map((u) => http(u, { timeout: 20_000, retryCount: 1 })), { retryCount: 2 })
    client = createPublicClient({ chain: chainId === 56 ? bsc : bscTestnet, transport }) as PublicClient
    clients.set(chainId, client)
  }
  return { client, blockNumber, chainId }
}

/** PancakeSwap V3 periphery. The factory shares one address on both networks; the position managers differ. */
export const PANCAKE: Record<56 | 97, { positionManager: `0x${string}`; factory: `0x${string}` }> = {
  56: { positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' },
  97: { positionManager: '0x427bF5b37357632377eCbEC9de3626C71A5396c1', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' },
}

export const abis = {
  erc20: parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)']),
  positionManager: parseAbi(['function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)', 'function ownerOf(uint256) view returns (address)']),
  factory: parseAbi(['function getPool(address, address, uint24) view returns (address)']),
  pool: parseAbi([
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16, uint32, bool)',
    'function tickSpacing() view returns (int24)',
    'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  ]),
} as const
