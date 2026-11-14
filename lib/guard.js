'use strict';
/**
 * BeruangGuard core — deterministic ERC-20 approval screening.
 *
 * Zero dependencies. Pure Node.js (fetch + BigInt). Shared by the local
 * server (server.js) and the Vercel serverless functions (api/*.js).
 *
 * Every check reads live, public on-chain data from BSC RPC endpoints.
 * Same input + same chain state = same verdict. No model calls, no API keys.
 */

const MAX_UINT256 = (1n << 256n) - 1n;

// EIP-7702 delegation designator: 0xef0100 + 20-byte implementation address.
// An account carrying it is still an EOA — its owner can change or revoke
// the delegation at any time — so it must NOT count as a "contract spender".
const EIP7702_PREFIX = '0xef0100';

const RPC_ENDPOINTS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc.publicnode.com',
  'https://bsc-dataseed1.bnbchain.org',
];

const SELECTORS = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
};

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

let rpcIndex = 0;

async function rpc(method, params, timeoutMs = 5000) {
  // Rotate endpoints on failure; try each at most once per call.
  let lastError;
  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    const url = RPC_ENDPOINTS[(rpcIndex + attempt) % RPC_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || 'RPC error');
      rpcIndex = (rpcIndex + attempt) % RPC_ENDPOINTS.length; // stick with what works
      return body.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`all RPC endpoints failed: ${lastError && lastError.message}`);
}

function padAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

async function ethCall(to, data, block = 'latest') {
  return rpc('eth_call', [{ to, data }, block]);
}

async function getCode(addr, block = 'latest') {
  return rpc('eth_getCode', [addr, block]);
}

// ---------------------------------------------------------------------------
// ABI decoding (minimal, hand-rolled)
// ---------------------------------------------------------------------------

function decodeUint256(hex) {
  if (!hex || hex === '0x') return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

// ERC-20 name()/symbol() may return an ABI string OR a bytes32.
function decodeStringOrBytes32(hex) {
  if (!hex || hex === '0x') return null;
  const raw = hex.replace(/^0x/, '');
  if (raw.length < 64) return null;
  // bytes32 case: 32 bytes of ASCII, null-padded, no offset/length header.
  if (raw.length === 64) {
    const s = Buffer.from(raw, 'hex').toString('utf8').replace(/\0+$/g, '');
    return /^[\x20-\x7e]*$/.test(s) && s.length > 0 ? s : null;
  }
  try {
    const offset = Number(BigInt('0x' + raw.slice(0, 64))) * 2;
    const len = Number(BigInt('0x' + raw.slice(offset, offset + 64)));
    const data = raw.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

// Classify an eth_getCode result:
//   'eoa'       — no code at all
//   'eip7702'   — EIP-7702 delegation designator (still an EOA underneath)
//   'contract'  — real deployed bytecode
function classifyCode(code) {
  if (!code || code === '0x' || code === '0X' || code.length <= 2) return 'eoa';
  if (code.toLowerCase().startsWith(EIP7702_PREFIX) && code.length === 48) return 'eip7702';
  return 'contract';
}

// ---------------------------------------------------------------------------
// The screen itself
// ---------------------------------------------------------------------------

/**
 * Screen an ERC-20 approval before it is signed.
 *
 * @param {object} input
 * @param {number} [input.chainId=56]  Only BSC (56) is supported for now.
 * @param {string} input.token         ERC-20 contract address.
 * @param {string} input.spender       Address that would receive the approval.
 * @param {string} input.amount        Raw token units as a decimal string,
 *                                     or the literal string "unlimited".
 * @param {string} [input.owner]       Optional wallet that would sign.
 * @returns {Promise<object>} { verdict, riskScore, reasons, checks }
 */
async function screenApproval(input) {
  const chainId = input.chainId === undefined ? 56 : Number(input.chainId);
  if (chainId !== 56) {
    const err = new Error('only BSC (chainId 56) is supported');
    err.status = 400;
    throw err;
  }
  if (!isAddress(input.token)) {
    const err = new Error('token must be a valid 0x address');
    err.status = 400;
    throw err;
  }
  if (!isAddress(input.spender)) {
    const err = new Error('spender must be a valid 0x address');
    err.status = 400;
    throw err;
  }
  if (input.owner !== undefined && input.owner !== null && !isAddress(input.owner)) {
    const err = new Error('owner must be a valid 0x address');
    err.status = 400;
    throw err;
  }

  let amount;
  if (typeof input.amount === 'string' && input.amount.toLowerCase() === 'unlimited') {
    amount = MAX_UINT256;
  } else {
    try {
      amount = BigInt(input.amount);
    } catch {
      const err = new Error('amount must be a decimal integer string or "unlimited"');
      err.status = 400;
      throw err;
    }
    if (amount < 0n) {
      const err = new Error('amount must not be negative');
      err.status = 400;
      throw err;
    }
  }

  const token = input.token;
  const spender = input.spender;
  const owner = input.owner || null;

  const reasons = [];
  const checks = {};
  let riskScore = 0;

  const add = (points, reason) => {
    riskScore += points;
    if (reason) reasons.push(reason);
  };

  // -- 1. Does the token address hold contract code? -------------------------
  // (An EIP-7702 delegation is not a token: the account is still an EOA.)
  const tokenCode = await getCode(token);
  const tokenCodeType = classifyCode(tokenCode);
  const tokenIsContract = tokenCodeType === 'contract';
  checks.tokenIsContract = tokenIsContract;
  checks.tokenCodeType = tokenCodeType;
  if (!tokenIsContract) {
    return {
      verdict: 'BLOCK',
      riskScore: 100,
      reasons: [
        tokenCodeType === 'eip7702'
          ? 'Token address carries only an EIP-7702 delegation designator — it is an EOA, not an ERC-20 token contract.'
          : 'Token address has no contract code — it is not an ERC-20 token.',
      ],
      checks: { ...checks, token: null, spender: null },
    };
  }

  // -- 2. Token metadata (name / symbol / decimals / totalSupply) ------------
  const [nameHex, symbolHex, decimalsHex, supplyHex] = await Promise.all([
    ethCall(token, SELECTORS.name).catch(() => null),
    ethCall(token, SELECTORS.symbol).catch(() => null),
    ethCall(token, SELECTORS.decimals).catch(() => null),
    ethCall(token, SELECTORS.totalSupply).catch(() => null),
  ]);
  const name = decodeStringOrBytes32(nameHex);
  const symbol = decodeStringOrBytes32(symbolHex);
  const decimalsRaw = decodeUint256(decimalsHex);
  const decimals = decimalsRaw !== null && decimalsRaw <= 255n ? Number(decimalsRaw) : null;
  const totalSupply = decodeUint256(supplyHex);

  checks.token = {
    name,
    symbol,
    decimals,
    totalSupply: totalSupply !== null ? totalSupply.toString() : null,
  };

  if (name === null && symbol === null && decimals === null) {
    add(15, 'Could not read token name/symbol/decimals — the token is unverifiable.');
  }
  if (totalSupply !== null && totalSupply === 0n) {
    add(15, 'Token totalSupply is 0 — the token holds no value.');
  }

  // -- 3. Is the spender a contract or an EOA? -------------------------------
  // An EIP-7702 delegation counts as an EOA: the owner can change or revoke
  // the delegation, so approving it is as dangerous as approving an EOA.
  const spenderCode = await getCode(spender);
  const spenderCodeType = classifyCode(spenderCode);
  const spenderIsContract = spenderCodeType === 'contract';
  checks.spender = { isContract: spenderIsContract, codeType: spenderCodeType };

  if (!spenderIsContract) {
    // Approving an EOA is almost always a scam: a real protocol, router or
    // wallet contract is a contract. Forcing BLOCK, not just a high score.
    return {
      verdict: 'BLOCK',
      riskScore: 100,
      reasons: [
        ...reasons,
        spenderCodeType === 'eip7702'
          ? 'Spender carries only an EIP-7702 delegation designator — it is an EOA underneath, and the owner can change the delegation at any time. Approving it is almost always a scam pattern.'
          : 'Spender is an externally owned account (EOA), not a contract — approving an EOA is almost always a scam pattern.',
      ],
      checks,
    };
  }

  // -- 4. Spender contract age ----------------------------------------------
  // NOT implemented on purpose: public BSC nodes prune historical state, so
  // eth_getCode at a block ~30 days old fails with "missing trie node" on
  // every public endpoint we tried. Contract age needs an archive node or an
  // indexer (e.g. BscScan API) — see README "Limitations". We deliberately do
  // NOT guess an age from data we cannot verify.

  // -- 5. Spender == token contract itself? ----------------------------------
  const spenderIsToken = spender.toLowerCase() === token.toLowerCase();
  checks.spenderIsToken = spenderIsToken;
  if (spenderIsToken) {
    add(25, 'Spender is the token contract itself — an unusual approval target.');
  }

  // -- 6. Unlimited / effectively-unlimited amount? ---------------------------
  const isMaxUint = amount === MAX_UINT256;
  const exceedsSupply = totalSupply !== null && totalSupply > 0n && amount >= totalSupply;
  const isUnlimited = isMaxUint || exceedsSupply;
  checks.amount = {
    raw: amount.toString(),
    isMaxUint256: isMaxUint,
    exceedsTotalSupply: exceedsSupply,
    isUnlimited,
  };
  if (isUnlimited) {
    add(
      45,
      isMaxUint
        ? 'Unlimited approval (2^256-1): the spender could drain the full token balance at any time.'
        : 'Approval amount is >= the token total supply — effectively unlimited.'
    );
  }

  // -- 7. Owner context: balance + existing allowance -------------------------
  if (owner) {
    const [balanceHex, allowanceHex] = await Promise.all([
      ethCall(token, SELECTORS.balanceOf + padAddress(owner)).catch(() => null),
      ethCall(token, SELECTORS.allowance + padAddress(owner) + padAddress(spender)).catch(() => null),
    ]);
    const balance = decodeUint256(balanceHex);
    const existingAllowance = decodeUint256(allowanceHex);
    checks.owner = {
      balance: balance !== null ? balance.toString() : null,
      existingAllowance: existingAllowance !== null ? existingAllowance.toString() : null,
    };
    if (balance !== null && amount > balance && !isUnlimited) {
      add(20, 'Approval amount exceeds the owner balance — the approval is larger than what the wallet holds.');
    }
    if (existingAllowance !== null && existingAllowance > 0n) {
      if (existingAllowance >= amount) {
        reasons.push('Note: an allowance of this size (or larger) is already granted to this spender.');
      } else {
        reasons.push('Note: this spender already holds a non-zero allowance from this owner.');
      }
    }
  }

  // -- Verdict ----------------------------------------------------------------
  if (riskScore >= 70) {
    return { verdict: 'BLOCK', riskScore: Math.min(riskScore, 100), reasons, checks };
  }
  if (riskScore >= 35) {
    return { verdict: 'WARN', riskScore, reasons, checks };
  }
  if (reasons.length === 0) {
    reasons.push('No risk signals found: token is a verified contract, spender is an established contract, amount is bounded.');
  }
  return { verdict: 'ALLOW', riskScore, reasons, checks };
}

module.exports = { screenApproval, MAX_UINT256, RPC_ENDPOINTS };
