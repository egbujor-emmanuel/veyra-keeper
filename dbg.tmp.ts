import { ERC8183JobOps } from '@bnbagent/sdk/erc8183'
import { sdkWallet } from './src/wallet.js'
process.env['RPC_URL_BSC_TESTNET'] ??= 'https://bsc-testnet-rpc.publicnode.com'
const ops = await ERC8183JobOps.create({ walletProvider: sdkWallet(), network: 'bsc-testnet', servicePrice: 10_000_000_000_000_000n })
for (const id of [1698, 1699]) {
  const j = await ops.getJob(id)
  console.log('job', id, JSON.stringify(j, (_k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 900))
  const v = await ops.verifyJob(id)
  console.log('verify', id, JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x).slice(0, 900))
}
