# VEYRA Keeper

A rebalancing agent for PancakeSwap V3 on BNB Chain, built from VEYRA's range engine for BNB Chain's Set and Earn campaign.

**Live:** https://veyra-keeper.vercel.app · **Hire it:** [Marque](https://marque.trade/agents/97/2718) · [Pokter](https://pokter.xyz/agents/97/2718)

| | |
|---|---|
| **ERC-8004 agent id** | **2718** |
| **Chain** | **BSC testnet (chain 97)** |
| Identity registry | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.bscscan.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| Owner and agent wallet | [`0xeDeaA0714213eCCaB5ab9CF602EafE4F7A741b3C`](https://testnet.bscscan.com/address/0xeDeaA0714213eCCaB5ab9CF602EafE4F7A741b3C) |
| Registration tx | [`0xb36544c5…32e2d6`](https://testnet.bscscan.com/tx/0xb36544c55bc613db703014e2fa173b123336bf494947c076e11b021f5532e2d6) |
| Category | rebalancing |
| Agent card | https://veyra-keeper.vercel.app/.well-known/agent-card.json |
| Registration file | https://veyra-keeper.vercel.app/.well-known/agent-registration.json |
| Live status and action log | https://veyra-keeper.vercel.app/api/status |

## Try it

Free, read-only preview (no wallet):

```bash
curl -s -X POST https://veyra-keeper.vercel.app/a2a -H 'content-type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"role":"user","messageId":"1","parts":[{"kind":"text","text":"Re-centre PancakeSwap V3 position 7683201 at ±6% at block 131045525 on chain 56"}]}}}'
```

Hire it through ERC-8183 escrow on a Set and Earn marketplace (Marque, Pokter): the agent signs a quote (0.01 U), you fund the job, and it submits the report's hash on chain.

## What it does

**For a buyer.** Send a position NFT id (or the wallet that owns it), optionally a width (`±8%`) and a block. It reads the position and its pool at that block and returns the current tick, whether it is in range, the distance to the nearer bound, a re-centred range on valid ticks, the token amounts that keep the same liquidity (V3 liquidity formula), and a slippage bound. With no width given, the range is sized at two daily standard deviations of the pool's own realised volatility over 24 hours. It never asks for an approval and never touches the buyer's wallet.

It passes Marque's conformance test **MCS-REB-1** on the published case (`npm run test:mcs`, graded by Marque's own grader).

**On its own.** The keeper runs its own USDT/WBNB 0.25% position on BSC testnet (`src/keeper.ts`), sized from mainnet PancakeSwap USDT/WBNB's realised volatility, and re-centres it on chain when:

- the price leaves the range,
- the centre drifts more than a third of the half-width,
- the volatility-sized width moves more than 20% from the range in place, or
- a UTC day passes without a re-centre.

At most 3 re-centres per UTC day. Each one closes the old position (decrease, collect, burn), rebalances inventory toward 50/50 if one side is under 30%, and mints the new range with 1% minimums from a simulation. Every action is logged at `/api/status`.

## How it runs

| Piece | Where |
|---|---|
| A2A card, `message/send`, ERC-8183 `negotiate` and `notify_funded` | Vercel functions (`api/`) |
| Quote signing, job verification, on-chain submit | `@bnbagent/sdk` (`src/seller.ts`) |
| Deliverable manifests | Vercel Blob (public URL committed on chain) |
| Keeper cycle every 4 h, delivery sweep every 15 min | GitHub Actions (`.github/workflows/keeper.yml`) plus a daily Vercel Cron backup |

The agent wallet's key lives only in Vercel's encrypted environment. Everything is BSC testnet: test tokens, no real funds.

## Develop

```bash
npm install
npm run test:mcs     # Marque MCS-REB-1, graded live
npx tsc --noEmit
```
