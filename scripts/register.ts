/**
 * Register VEYRA Keeper on the BSC testnet ERC-8004 IdentityRegistry, owned by the agent wallet.
 * Usage: AGENT_PRIVATE_KEY=0x... npx tsx scripts/register.ts
 * Prints the agent id and transaction hash. Refuses to run if the wallet already owns an identity
 * pointing at this agent's registration file, so the same agent is never registered twice.
 */
import { ERC8004Agent } from '@bnbagent/sdk/erc8004'
import { publicUrl } from '../src/config.js'
import { sdkWallet } from '../src/wallet.js'

process.env['RPC_URL_BSC_TESTNET'] ??= 'https://bsc-testnet-rpc.publicnode.com'
const uri = `${publicUrl()}/.well-known/agent-registration.json`

const agent = await ERC8004Agent.create({ walletProvider: sdkWallet(), network: 'bsc-testnet' })
const result = await agent.registerAgent(uri)
console.log(JSON.stringify({ registry: agent.contractAddress, owner: sdkWallet().address, agentUri: uri, agentId: result.agentId, transactionHash: result.transactionHash }, null, 2))
