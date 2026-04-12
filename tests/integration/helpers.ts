/**
 * tests/integration/helpers.ts
 *
 * Shared utilities for AgentSwap integration tests.
 *
 * Self-contained: only uses Node built-ins + packages already installed in
 * the workspace (ethers is available via @agentswap/ethereum's peer dep).
 * No extra test-only packages required.
 */

import https from "https";
import http from "http";
import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const SERVER_URL    = process.env.SERVER_URL     ?? "http://localhost:3001";
export const ETH_RPC_URL   = process.env.ETH_RPC_URL    ?? "http://localhost:8545";
export const BUYER_LND_URL = process.env.BUYER_LND_URL  ?? "https://localhost:8080";
export const SELLER_LND_URL = process.env.SELLER_LND_URL ?? "https://localhost:8081";

// Ganache deterministic accounts (mnemonic: "abandon abandon...about")
export const BUYER_ETH_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const BUYER_ETH_KEY     = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const SELLER_ETH_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const SELLER_ETH_KEY    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export const DEFAULT_TEST_TIMEOUT_MS = 180_000; // 3 min

// ── Inline HTLC ABI (subset needed for tests) ─────────────────────────────────

export const HTLC_ABI = [
  "function getLock(bytes32 lockId) external view returns (tuple(address buyer, address seller, uint256 amount, bytes32 preimageHash, uint256 expiry, bool claimed, bool refunded) lock)",
  "function claim(bytes32 lockId, bytes32 preimage) external",
  "function refund(bytes32 lockId) external",
  "event Claimed(bytes32 indexed lockId, bytes32 preimage, uint256 claimedAt)",
  "event Refunded(bytes32 indexed lockId, uint256 refundedAt)",
  "error BadPreimage(bytes32 lockId)",
  "error LockNotExpired(bytes32 lockId)",
  "error AlreadyClaimed(bytes32 lockId)",
] as const;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

export async function doGet(url: string, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod: typeof https = parsed.protocol === "https:" ? https : (http as unknown as typeof https);
    const agent: https.Agent | undefined = parsed.protocol === "https:" ? INSECURE_AGENT : undefined;

    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: "GET", agent },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`GET ${url} timed out`)); });
    req.on("error", reject);
    req.end();
  });
}

export async function doPost(url: string, payload: unknown, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod: typeof https = parsed.protocol === "https:" ? https : (http as unknown as typeof https);
    const agent: https.Agent | undefined = parsed.protocol === "https:" ? INSECURE_AGENT : undefined;

    const req = mod.request(
      {
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (d: Buffer) => { data += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`POST ${url} timed out`)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────

export async function ethJsonRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const resp = await doPost(ETH_RPC_URL, { jsonrpc: "2.0", method, params, id: Date.now() });
  const parsed = JSON.parse(resp.body) as { result?: unknown; error?: { message: string } };
  if (parsed.error) throw new Error(`JSON-RPC ${method}: ${parsed.error.message}`);
  return parsed.result;
}

/**
 * Advance Ganache time by `seconds` seconds and mine a new block.
 * This makes the ETH HTLC timelock expire immediately for testing.
 */
export async function advanceGanacheTime(seconds: number): Promise<void> {
  await ethJsonRpc("evm_increaseTime", [seconds]);
  await ethJsonRpc("evm_mine", []);
}

/** Current latest block timestamp from Ganache. */
export async function ganacheTimestamp(): Promise<number> {
  const block = await ethJsonRpc("eth_getBlockByNumber", ["latest", false]) as { timestamp: string };
  return parseInt(block.timestamp, 16);
}

// ── Swap API helpers ──────────────────────────────────────────────────────────

export interface StartScenarioResponse {
  swapId: string;
  scenario: string;
  speedMode: string;
  message: string;
}

export interface StartSwapResponse {
  swapId: string;
  message: string;
}

export interface SwapRecord {
  id: string;
  state: string;
  proposal: {
    id: string;
    taskDescription: string;
    btcAmountSats: string | number;
    ethAmountWei: string | number;
    timelock_eth_hours: number;
    timelock_btc_hours: number;
    preimageHash: string;
  };
  preimageHash: string;
  ethLockId?: string;
  ethReceipt?: {
    chain: "eth";
    txId: string;
    amount: string;
    preimageHash: string;
    contractAddress?: string;
  };
  btcRHash?: string;
  btcPaymentRequest?: string;
  btcReceipt?: {
    chain: "btc";
    txId: string;
    amount: string;
    preimageHash: string;
    invoice?: string;
  };
  qualityScore?: number;
  arbitratorReasoning?: string;
  settledAt?: number;
  refundedAt?: number;
  messages?: unknown[];
}

export async function startScenario(scenarioId: string): Promise<StartScenarioResponse> {
  const resp = await doPost(`${SERVER_URL}/demo/start-scenario`, { scenarioId }, 15_000);
  if (resp.status !== 200) throw new Error(`start-scenario HTTP ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as StartScenarioResponse;
}

export async function startSwap(taskDescription: string, buyerBudgetSats = 100_000): Promise<StartSwapResponse> {
  const resp = await doPost(`${SERVER_URL}/swap/start`, { taskDescription, buyerBudgetSats }, 15_000);
  if (resp.status !== 200) throw new Error(`swap/start HTTP ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as StartSwapResponse;
}

export async function getSwap(swapId: string): Promise<SwapRecord> {
  const resp = await doGet(`${SERVER_URL}/swap/${swapId}`, 8_000);
  if (resp.status !== 200) throw new Error(`GET /swap/${swapId} HTTP ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as SwapRecord;
}

export async function triggerRefund(swapId: string, reason = "Test-triggered refund"): Promise<void> {
  await doPost(`${SERVER_URL}/swap/${swapId}/trigger-refund`, { reason }, 8_000);
}

// ── LND helpers ───────────────────────────────────────────────────────────────

export async function lndGet<T>(baseUrl: string, path: string): Promise<T> {
  const resp = await doGet(`${baseUrl}${path}`, 8_000);
  if (resp.status !== 200) throw new Error(`LND GET ${path} → HTTP ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as T;
}

export async function lndPost<T>(baseUrl: string, path: string, payload: unknown): Promise<T> {
  const resp = await doPost(`${baseUrl}${path}`, payload, 60_000);
  if (resp.status !== 200) throw new Error(`LND POST ${path} → HTTP ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as T;
}

/**
 * Pay a BOLT-11 invoice from the BUYER's LND node.
 * Funds get locked in the seller's HODL invoice — this is the BTC lock step.
 */
export async function payBtcInvoice(paymentRequest: string): Promise<{ paymentHash: string; status: string }> {
  const resp = await lndPost<{ payment_hash: string; status: string }>(
    BUYER_LND_URL,
    "/v2/router/send",
    {
      payment_request: paymentRequest,
      timeout_seconds: 60,
      fee_limit_sat: 1_000,
      no_inflight_updates: true,
    }
  );
  return { paymentHash: resp.payment_hash, status: resp.status };
}

/**
 * Look up a Lightning invoice state from the SELLER's LND node.
 * Returns state: "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED"
 */
export async function lookupInvoice(rHashHex: string): Promise<{ state: string; amt_paid_sat?: string }> {
  const b64url = Buffer.from(rHashHex, "hex").toString("base64url");
  return lndGet(SELLER_LND_URL, `/v2/invoices/lookup?payment_hash=${b64url}`);
}

// ── SSE client ────────────────────────────────────────────────────────────────

export interface ParsedSSEEvent {
  type: string;
  data: unknown;
  rawData: string;
}

/**
 * Connect to the SSE stream and return an object with `waitForEvent` and `close`.
 *
 * Works with Node 20's http module — no EventSource polyfill needed.
 *
 * Usage:
 *   const sse = connectSSE();
 *   const evt = await sse.waitForEvent("swap_settled", 60_000);
 *   sse.close();
 */
export function connectSSE(url = `${SERVER_URL}/events`): {
  waitForEvent(type: string, swapId: string, timeoutMs: number): Promise<ParsedSSEEvent>;
  waitForAnyEvent(types: string[], swapId: string, timeoutMs: number): Promise<ParsedSSEEvent>;
  collectStateChanges(swapId: string, until: string, timeoutMs: number): Promise<string[]>;
  close(): void;
} {
  const listeners = new Map<string, Array<(evt: ParsedSSEEvent) => void>>();
  let req: http.ClientRequest;
  let closed = false;

  function emit(evt: ParsedSSEEvent): void {
    const handlers = listeners.get(evt.type) ?? [];
    handlers.forEach((h) => h(evt));
    // Also emit to "*" wildcard listeners
    (listeners.get("*") ?? []).forEach((h) => h(evt));
  }

  function addListener(type: string, fn: (e: ParsedSSEEvent) => void): void {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(fn);
  }

  function removeListener(type: string, fn: (e: ParsedSSEEvent) => void): void {
    const list = listeners.get(type) ?? [];
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  const parsed = new URL(url);
  req = http.request(
    { hostname: parsed.hostname, port: Number(parsed.port) || 3001, path: parsed.pathname, method: "GET" },
    (res) => {
      let buffer = "";
      let currentType = "";
      let currentData = "";

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" || line === "\r") {
            if (currentData) {
              try {
                emit({ type: currentType || "message", data: JSON.parse(currentData), rawData: currentData });
              } catch {
                // ignore unparseable data
              }
              currentType = "";
              currentData = "";
            }
          }
        }
      });
    }
  );
  req.on("error", () => { /* swallow connection errors on close */ });
  req.end();

  return {
    waitForEvent(type: string, swapId: string, timeoutMs: number): Promise<ParsedSSEEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          removeListener(type, handler);
          reject(new Error(`Timeout waiting for SSE event "${type}" (swapId=${swapId}) after ${timeoutMs}ms`));
        }, timeoutMs);

        function handler(evt: ParsedSSEEvent) {
          const d = evt.data as { swapId?: string };
          if (swapId && d?.swapId !== swapId) return;
          clearTimeout(timer);
          removeListener(type, handler);
          resolve(evt);
        }
        addListener(type, handler);
      });
    },

    waitForAnyEvent(types: string[], swapId: string, timeoutMs: number): Promise<ParsedSSEEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          types.forEach((t) => removeListener(t, handler));
          reject(new Error(`Timeout waiting for any of [${types.join(",")}] after ${timeoutMs}ms`));
        }, timeoutMs);

        function handler(evt: ParsedSSEEvent) {
          const d = evt.data as { swapId?: string };
          if (swapId && d?.swapId !== swapId) return;
          clearTimeout(timer);
          types.forEach((t) => removeListener(t, handler));
          resolve(evt);
        }
        types.forEach((t) => addListener(t, handler));
      });
    },

    collectStateChanges(swapId: string, untilState: string, timeoutMs: number): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const states: string[] = [];
        const timer = setTimeout(() => {
          removeListener("state_change", handler);
          reject(new Error(`Timeout waiting for state "${untilState}" in ${timeoutMs}ms. States seen: [${states.join(",")}]`));
        }, timeoutMs);

        function handler(evt: ParsedSSEEvent) {
          const d = evt.data as { swapId?: string; newState?: string };
          if (d?.swapId !== swapId) return;
          if (d.newState) states.push(d.newState);
          if (d.newState === untilState || d.newState === "REFUNDED") {
            clearTimeout(timer);
            removeListener("state_change", handler);
            resolve(states);
          }
        }
        addListener("state_change", handler);
      });
    },

    close() {
      if (!closed) {
        closed = true;
        req.destroy();
      }
    },
  };
}

// ── Preimage / hash helpers ───────────────────────────────────────────────────

/**
 * SHA-256(preimage_bytes) — matches LND's payment hash calculation.
 * Preimage is a 32-byte hex string (with or without 0x prefix).
 */
export function sha256Btc(preimageHex: string): string {
  const clean = preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex;
  return crypto.createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
}

/**
 * Compute sha256(abi.encodePacked(bytes32(preimage))) — matches AgentSwapHTLC.sol.
 * Uses the same zero-padding + solidityPacked logic as the ethers.js client.
 *
 * Requires: ethers >= 6 (loaded from @agentswap/ethereum).
 */
export function sha256Eth(preimageHex: string): string {
  // Mirror: sha256(abi.encodePacked(bytes32(preimage)))
  // abi.encodePacked(bytes32(x)) is just the 32-byte big-endian value of x.
  const clean = preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex;
  const padded = clean.padStart(64, "0"); // 32 bytes, big-endian
  const hash = crypto.createHash("sha256").update(Buffer.from(padded, "hex")).digest("hex");
  return "0x" + hash;
}

// ── ETH contract interaction (without importing ethers — uses JSON-RPC) ───────

/**
 * Call getLock() via eth_call JSON-RPC.
 *
 * Encodes the calldata manually to avoid importing ethers in test helpers.
 * Returns the decoded Lock struct fields.
 */
export async function getLockViaRpc(contractAddress: string, lockId: string): Promise<{
  buyer: string; seller: string; amount: bigint; preimageHash: string;
  expiry: bigint; claimed: boolean; refunded: boolean;
}> {
  // getLock(bytes32 lockId) selector = keccak256("getLock(bytes32)")[0:4]
  const selector = "0xe0c94f69"; // pre-computed
  const clean = lockId.startsWith("0x") ? lockId.slice(2) : lockId;
  const data = selector + clean.padStart(64, "0");

  const result = await ethJsonRpc("eth_call", [{ to: contractAddress, data }, "latest"]) as string;

  if (!result || result === "0x") throw new Error(`getLock returned empty — lockId ${lockId} not found`);

  // ABI-decode the returned tuple (256-bit slots):
  // 0: buyer (address, right-padded in slot)
  // 1: seller
  // 2: amount
  // 3: preimageHash (bytes32)
  // 4: expiry
  // 5: claimed (bool)
  // 6: refunded (bool)
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  const slots = [];
  for (let i = 0; i < hex.length; i += 64) {
    slots.push(hex.slice(i, i + 64));
  }

  if (slots.length < 7) throw new Error(`getLock response too short (${slots.length} slots)`);

  return {
    buyer:        "0x" + slots[0].slice(24),
    seller:       "0x" + slots[1].slice(24),
    amount:       BigInt("0x" + slots[2]),
    preimageHash: "0x" + slots[3],
    expiry:       BigInt("0x" + slots[4]),
    claimed:      slots[5] !== "0".repeat(63) + "0" && slots[5] !== "0".repeat(64),
    refunded:     slots[6] !== "0".repeat(63) + "0" && slots[6] !== "0".repeat(64),
  };
}

/**
 * Encode and send a refund(bytes32 lockId) transaction via eth_sendRawTransaction.
 * Uses the buyer's private key to sign (they deployed the lock).
 *
 * Requires: ethers (available via workspace dep).
 */
export async function refundLockViaEthers(
  contractAddress: string,
  lockId: string,
  signerPrivateKey = BUYER_ETH_KEY
): Promise<string> {
  // We dynamically import ethers here to avoid circular deps and keep
  // the helper file usable even if ethers tree-shaking removes unused exports.
  const { ethers } = await import("ethers");

  const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
  const signer   = new ethers.Wallet(signerPrivateKey, provider);
  const contract = new ethers.Contract(contractAddress, HTLC_ABI, signer);

  const tx = await (contract.refund as (lockId: string) => Promise<{ wait: () => Promise<{ hash: string }> }>)(lockId);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Call claim(bytes32 lockId, bytes32 preimage) using the SELLER's ETH key.
 */
export async function claimLockViaEthers(
  contractAddress: string,
  lockId: string,
  preimageHex: string,
  signerPrivateKey = SELLER_ETH_KEY
): Promise<string> {
  const { ethers } = await import("ethers");

  const provider  = new ethers.JsonRpcProvider(ETH_RPC_URL);
  const signer    = new ethers.Wallet(signerPrivateKey, provider);
  const contract  = new ethers.Contract(contractAddress, HTLC_ABI, signer);

  const clean  = preimageHex.startsWith("0x") ? preimageHex : "0x" + preimageHex;
  const padded = ethers.zeroPadValue(clean, 32);

  const tx = await (contract.claim as (
    lockId: string, preimage: string
  ) => Promise<{ wait: () => Promise<{ hash: string }> }>)(lockId, padded);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Get the ETH balance of an address in wei.
 */
export async function getEthBalance(address: string): Promise<bigint> {
  const hex = await ethJsonRpc("eth_getBalance", [address, "latest"]) as string;
  return BigInt(hex);
}

/**
 * Get the deployed contract address from the deployments JSON or env.
 */
export function getContractAddress(): string {
  const fromEnv = process.env.ETH_HTLC_CONTRACT_ADDRESS
    || process.env.AGENTSWAP_HTLC_CONTRACT_ADDRESS;
  if (fromEnv) return fromEnv;

  // Try to read from deployments JSON
  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs");
    const { resolve } = require("path") as typeof import("path");
    const deployPath = resolve(process.cwd(), "packages/ethereum/deployments/localhost.json");
    if (existsSync(deployPath)) {
      const records = JSON.parse(readFileSync(deployPath, "utf8")) as Array<{ contract: string; address: string }>;
      const rec = records.find((r) => r.contract === "AgentSwapHTLC");
      if (rec?.address) return rec.address;
    }
  } catch { /* ignore */ }

  throw new Error(
    "Contract address not found. Set ETH_HTLC_CONTRACT_ADDRESS env var or run: " +
    "pnpm --filter @agentswap/ethereum deploy:agentswap"
  );
}

// ── Polling helper ────────────────────────────────────────────────────────────

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  { intervalMs = 2_000, timeoutMs = 60_000, label = "condition" } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}
