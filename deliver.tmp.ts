import { deliver } from './src/seller.js'
process.env['RPC_URL_BSC_TESTNET'] ??= 'https://bsc-testnet-rpc.publicnode.com'
for (const id of [1698, 1699]) {
  try { console.log(JSON.stringify(await deliver(id))) } catch (e) { console.log(id, 'ERR', (e as Error).message.slice(0, 400)) }
}
