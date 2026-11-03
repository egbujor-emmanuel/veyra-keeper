import { randomBytes } from 'node:crypto'
import { EVMWalletProvider } from '@bnbagent/sdk'
import type { Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { requireEnv } from './config.js'

/**
 * The agent wallet. It owns the ERC-8004 identity, signs quotes, submits deliverables and runs the
 * keeper's own position. BSC testnet only: nothing in this service sends a mainnet transaction.
 */
export function agentKey(): Hex {
  const key = requireEnv('AGENT_PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('AGENT_PRIVATE_KEY must be 0x and 64 hex characters')
  return key as Hex
}

export function agentAccount(): PrivateKeyAccount {
  return privateKeyToAccount(agentKey())
}

let provider: EVMWalletProvider | null = null

/** The SDK's wallet over the same key, held in memory only (persist: false writes no keystore). */
export function sdkWallet(): EVMWalletProvider {
  provider ??= new EVMWalletProvider({ password: randomBytes(24).toString('hex'), privateKey: agentKey(), persist: false })
  return provider
}
