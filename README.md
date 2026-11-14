# 🐻 BeruangGuard — Wallet & Transaction Guard Agent

**Screen an ERC-20 token approval on BNB Chain *before* you sign it.**

An Agent Games (zkVerify) Wildcard-track entry.

## The problem

Token approvals are the quietest way wallets get drained. A dApp asks you to
`approve()` a spender, you click through, and that spender can move your tokens
— often **unlimited** (`2^256-1`), often forever. One unlimited approval to the
wrong address has cost real users real money, and the approval stays valid
until it is explicitly revoked. Most wallets show the approval request with
almost no context: no hint whether the spender is a contract or a random
wallet, no hint whether the amount is unlimited, no hint whether the token is
even real.

BeruangGuard answers those questions with live on-chain data, before the
signature happens.

## Who it helps

- **Everyday wallet users** who approve tokens on BSC and want a second opinion
  before signing.
- **Agents and wallets** that execute approvals on a user's behalf and need a
  deterministic, automatable safety check in the loop.
- **Anyone auditing approvals** — the same endpoint reports the allowance a
  spender already holds.

## How it works

One endpoint, `POST /screen`, runs a fixed set of checks against live BSC RPC
data and returns a deterministic verdict: `ALLOW`, `WARN`, or `BLOCK`, with a
0–100 risk score and human-readable reasons.

### Checks

| # | Check | Signal |
|---|-------|--------|
| 1 | Token address holds contract code | No code → **BLOCK** (not a token) |
| 2 | Token metadata readable (`name`/`symbol`/`decimals`, `totalSupply > 0`) | Unreadable / zero supply → +15 |
| 3 | Spender is a contract, not an EOA | EOA spender → **BLOCK** (approving an EOA is almost always a scam pattern) |
| 4 | EIP-7702 delegation detection | A spender carrying only a `0xef0100` delegation designator is still an EOA underneath → **BLOCK** |
| 5 | Spender == token contract itself | Unusual approval target → +25 |
| 6 | Unlimited amount (`2^256-1`, or amount ≥ total supply) | Effectively unlimited → +45 |
| 7 | Owner balance (when `owner` is given) | Approval larger than balance → +20 |
| 8 | Existing allowance (when `owner` is given) | Reported; notes if an allowance is already granted |

**Scoring:** 0–34 → `ALLOW`, 35–69 → `WARN`, 70+ → `BLOCK`. Rules 1, 3 and 4
force `BLOCK` immediately (score 100) because they indicate a structurally
unsafe approval, not a judgement call.

**Deterministic:** same input + same chain state = same output. No AI model
calls, no API keys, no randomness. The verdict was verified byte-identical
across two consecutive runs (see below).

**RPC:** public BSC endpoints with rotation and 5 s timeouts
(`bsc-dataseed.binance.org`, `bsc.publicnode.com`, `bsc-dataseed1.bnbchain.org`).
If one endpoint fails or rate-limits, the next one is tried.

### API

**`GET /health`** → `{ "ok": true }`

**`POST /screen`**

```json
{
  "chainId": 56,
  "token": "0x55d398326f99059fF775485246999027B3197955",
  "spender": "0xb300000b72DEAEb607a12d5f54773D1C19c7028d",
  "amount": "100000000",
  "owner": "0x..."
}
```

- `chainId` — optional, defaults to 56. Only BSC is supported for now.
- `token` — ERC-20 contract address.
- `spender` — address that would receive the approval.
- `amount` — raw token units as a decimal string, or the literal `"unlimited"`.
- `owner` — optional wallet that would sign; enables the balance and
  existing-allowance checks.

Response:

```json
{
  "verdict": "ALLOW",
  "riskScore": 0,
  "reasons": ["..."],
  "checks": { "tokenIsContract": true, "token": {...}, "spender": {...}, "...": "..." }
}
```

## Run locally

Requires Node.js ≥ 20. Zero dependencies — no `npm install` needed.

```bash
node server.js
# BeruangGuard listening on http://localhost:3000
```

Open http://localhost:3000 for the demo page, or call the API directly
(examples below). `PORT=8080 node server.js` changes the port.

## Deploy to Vercel

The same core logic (`lib/guard.js`) is shared by the local server and the
serverless functions in `api/`. `vercel.json` rewrites `/screen` → `/api/screen`
and `/health` → `/api/health`, so the demo page works unchanged.

```bash
npm i -g vercel   # once
vercel            # deploy; no env vars needed
```

## Real examples

All outputs below are actual server responses against live BSC state
(2026-11-14, block ~133,570,000). Re-run them yourself — the verdicts are
reproducible from public chain data.

### 1. Bounded USDT approval to a real wallet contract → ALLOW

```bash
curl -X POST http://localhost:3000/screen -H 'content-type: application/json' -d '{
  "chainId": 56,
  "token": "0x55d398326f99059fF775485246999027B3197955",
  "spender": "0xb300000b72DEAEb607a12d5f54773D1C19c7028d",
  "amount": "100000000"
}'
```

```json
{
  "verdict": "ALLOW",
  "riskScore": 0,
  "reasons": [
    "No risk signals found: token is a verified contract, spender is an established contract, amount is bounded."
  ],
  "checks": {
    "tokenIsContract": true,
    "tokenCodeType": "contract",
    "token": {
      "name": "Tether USD",
      "symbol": "USDT",
      "decimals": 18,
      "totalSupply": "9184991536508259764116723649"
    },
    "spender": { "isContract": true, "codeType": "contract" },
    "spenderIsToken": false,
    "amount": {
      "raw": "100000000",
      "isMaxUint256": false,
      "exceedsTotalSupply": false,
      "isUnlimited": false
    }
  }
}
```

The spender `0xb300…7028d` is the real Binance Wallet contract on BSC, and
100,000,000 raw units is a bounded amount — nothing to flag.

### 2. Unlimited USDT approval to an EOA → BLOCK

```bash
curl -X POST http://localhost:3000/screen -H 'content-type: application/json' -d '{
  "chainId": 56,
  "token": "0x55d398326f99059fF775485246999027B3197955",
  "spender": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "amount": "unlimited"
}'
```

```json
{
  "verdict": "BLOCK",
  "riskScore": 100,
  "reasons": [
    "Spender carries only an EIP-7702 delegation designator — it is an EOA underneath, and the owner can change the delegation at any time. Approving it is almost always a scam pattern."
  ],
  "checks": {
    "tokenIsContract": true,
    "tokenCodeType": "contract",
    "token": {
      "name": "Tether USD",
      "symbol": "USDT",
      "decimals": 18,
      "totalSupply": "9184991536508259764116723649"
    },
    "spender": { "isContract": false, "codeType": "eip7702" }
  }
}
```

This case caught a real subtlety: the spender address *does* have code on BSC —
a 23-byte EIP-7702 delegation (`0xef0100…`). A naive "has code = contract"
check would have passed it. BeruangGuard classifies the delegation correctly
and blocks the approval.

### 3. Token address with no code → BLOCK

```bash
curl -X POST http://localhost:3000/screen -H 'content-type: application/json' -d '{
  "chainId": 56,
  "token": "0x000000000000000000000000000000000000dEaD",
  "spender": "0xb300000b72DEAEb607a12d5f54773D1C19c7028d",
  "amount": "100000000"
}'
```

```json
{
  "verdict": "BLOCK",
  "riskScore": 100,
  "reasons": ["Token address has no contract code — it is not an ERC-20 token."],
  "checks": {
    "tokenIsContract": false,
    "tokenCodeType": "eoa",
    "token": null,
    "spender": null
  }
}
```

### Determinism check

Case 1 was run twice in a row; the two responses were byte-identical
(`diff` clean). The over-balance path was also verified live: an approval of
`10000000000000000000000000` raw units from an owner holding
`311849577277953166244446` USDT returned score 20 with the reason
"Approval amount exceeds the owner balance".

## Verifiability

Every verdict is a pure function of public chain state: anyone can re-run the
same `eth_getCode` / `eth_call` reads against any BSC node and reproduce the
same verdict. BeruangGuard never asks for a private key and never signs
anything — it only reads.

**Honest note on zkVerify:** this entry does **not** integrate zkVerify or any
zero-knowledge proving system today, and it does not claim to. The natural
next step is a zkTLS proof of the RPC responses behind a verdict: the agent
could attach a proof that the `eth_getCode` / `eth_call` results it based its
verdict on really came from the RPC endpoint it claims — making a verdict
checkable without trusting our server. That is future work, not a current
feature.

## Limitations

- **BSC only** (chainId 56). The checks are chain-agnostic in design; other
  EVM chains need only an RPC list.
- **No contract-age check.** We tried verifying spender age via `eth_getCode`
  at a block ~30 days old, but public BSC nodes prune historical state and
  return `missing trie node`. Age verification needs an archive node or an
  indexer (e.g. BscScan API) — deliberately left out rather than guessed.
- **No transaction screening yet.** The current scope is ERC-20 approvals
  (`approve`/`permit`-style allowance grants). Raw transaction screening
  (calldata decoding, value flows) is the next feature.
- **No reputation lists.** Verdicts come only from on-chain facts, not from a
  blocklist — a brand-new scam contract with plausible metadata can still
  score low. Pair with a blocklist for production use.

## Project layout

```
beruangguard/
├── lib/guard.js        # core screening logic (shared by both entry points)
├── server.js           # local server (http + static demo page)
├── api/
│   ├── screen.js       # Vercel serverless: POST /screen
│   └── health.js       # Vercel serverless: GET /health
├── public/index.html   # demo page
├── vercel.json         # /screen and /health rewrites for Vercel
├── package.json        # zero dependencies
└── LICENSE             # MIT
```

## License

MIT — see [LICENSE](LICENSE).
