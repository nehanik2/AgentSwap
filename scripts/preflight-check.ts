#!/usr/bin/env tsx
/**
 * scripts/preflight-check.ts
 *
 * AgentSwap — comprehensive pre-demo health check.
 *
 * Run with:  pnpm preflight
 *            tsx scripts/preflight-check.ts
 *
 * Exits 0 on GO, 1 on NO-GO.
 *
 * Checks (in order):
 *   1.  Docker containers running (bitcoind, buyer-lnd, seller-lnd, ganache)
 *   2.  LND buyer node synced + ≥500 000 sats local channel balance
 *   3.  LND seller node reachable and synced
 *   4.  Ethereum contract deployed (reads deployments/localhost.json)
 *   5.  Ganache buyer account has funds
 *   6.  Anthropic API key valid (minimal test call)
 *   7.  Express server responds at localhost:3001/health
 *   8.  Dashboard responds at localhost:3000
 *   9.  SSE endpoint streams (connects, verifies event-stream headers)
 */

import { execSync } from "child_process";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

// ── ANSI colours ──────────────────────────────────────────────────────────────

const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const D = "\x1b[0m";

// ── Config ────────────────────────────────────────────────────────────────────

// tsx runs as CJS; __dirname is available
const ROOT = path.resolve(__dirname, "..");

const SERVER_URL  = "http://localhost:3001";
const DASHBOARD_URL = "http://localhost:3000";
const LND_BUYER_URL  = "https://localhost:8080";
const LND_SELLER_URL = "https://localhost:8081";
const ETH_RPC_URL   = process.env.ETH_RPC_URL ?? "http://localhost:8545";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const MIN_CHANNEL_SATS = 500_000;

const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

// ── Result tracking ───────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

const results: CheckResult[] = [];
let totalMs = 0;

function pass(name: string, detail: string): void {
  results.push({ name, passed: true, detail });
  console.log(`  ${G}✔${D}  ${B}${name}${D} — ${detail}`);
}

function fail(name: string, detail: string, fix?: string): void {
  results.push({ name, passed: false, detail, fix });
  console.log(`  ${R}✗${D}  ${B}${name}${D} — ${detail}`);
  if (fix) console.log(`       ${Y}Fix:${D} ${fix}`);
}

function warn(name: string, detail: string, fix?: string): void {
  results.push({ name, passed: true, detail });
  console.log(`  ${Y}⚠${D}  ${B}${name}${D} — ${detail}`);
  if (fix) console.log(`       ${Y}Hint:${D} ${fix}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpGet(url: string, opts: { timeoutMs?: number; tlsAgent?: https.Agent } = {}): Promise<{ status: number; body: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const agent = parsed.protocol === "https:" ? (opts.tlsAgent ?? INSECURE_AGENT) : undefined;

    const req = (mod as typeof https).request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: "GET", agent },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );

    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.end();
  });
}

async function httpPost(url: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<{ status: number; body: string }> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const payload   = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const agent = parsed.protocol === "https:" ? INSECURE_AGENT : undefined;

    const req = (mod as typeof https).request(
      {
        hostname: parsed.hostname, port: parsed.port,
        path: parsed.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (d: Buffer) => { data += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );

    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function ethJsonRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const resp = await httpPost(ETH_RPC_URL, { jsonrpc: "2.0", method, params, id: 1 });
  const parsed = JSON.parse(resp.body) as { result?: unknown; error?: { message: string } };
  if (parsed.error) throw new Error(parsed.error.message);
  return parsed.result;
}

// ── Check functions ───────────────────────────────────────────────────────────

async function checkDockerContainers(): Promise<void> {
  const CONTAINERS = [
    { name: "agentswap-bitcoind",  label: "bitcoind" },
    { name: "agentswap-buyer-lnd", label: "buyer-lnd" },
    { name: "agentswap-seller-lnd",label: "seller-lnd" },
    { name: "agentswap-ganache",   label: "ganache" },
  ];

  let running: string[] = [];
  try {
    const raw = execSync('docker ps --format "{{.Names}}\t{{.Status}}"', { encoding: "utf8" });
    running = raw.split("\n").filter(Boolean);
  } catch {
    fail("Docker", "Could not run docker ps — is Docker Desktop running?", "Start Docker Desktop");
    return;
  }

  let allUp = true;
  for (const c of CONTAINERS) {
    const line = running.find((l) => l.startsWith(c.name));
    if (!line) {
      fail(`Docker: ${c.label}`, `Container ${c.name} is NOT running`, "Run: pnpm docker:up");
      allUp = false;
    } else if (line.includes("unhealthy")) {
      fail(`Docker: ${c.label}`, `Container ${c.name} is UNHEALTHY — ${line}`, "Run: pnpm docker:down && pnpm docker:up");
      allUp = false;
    } else {
      const status = line.split("\t")[1] ?? "unknown";
      pass(`Docker: ${c.label}`, `Running (${status.slice(0, 40)})`);
    }
  }

  if (!allUp) {
    console.log(`\n  ${Y}Hint:${D} Run 'pnpm docker:up' to start all services, then wait ~30 s for LND to sync.\n`);
  }
}

async function checkLndBuyer(): Promise<void> {
  try {
    const infoResp = await httpGet(`${LND_BUYER_URL}/v1/getinfo`);
    if (infoResp.status !== 200) throw new Error(`HTTP ${infoResp.status}`);
    const info = JSON.parse(infoResp.body) as { synced_to_chain?: boolean; alias?: string; block_height?: number };

    if (!info.synced_to_chain) {
      fail("LND buyer: sync", `Node NOT synced to chain (height=${info.block_height})`, "Run: pnpm docker:logs | grep buyer-lnd — wait for sync to complete");
      return;
    }

    const balResp = await httpGet(`${LND_BUYER_URL}/v1/balance/channels`);
    const bal = JSON.parse(balResp.body) as { local_balance?: { sat?: string }; balance?: string };
    const localSats = parseInt(bal.local_balance?.sat ?? bal.balance ?? "0", 10);

    if (localSats < MIN_CHANNEL_SATS) {
      fail(
        "LND buyer: channel balance",
        `Local balance ${localSats.toLocaleString()} sats < required ${MIN_CHANNEL_SATS.toLocaleString()} sats`,
        "Run: bash scripts/reset-demo-env.sh  (opens a fresh 2M-sat channel)"
      );
    } else {
      pass("LND buyer: channel balance", `${localSats.toLocaleString()} sats local (${info.alias ?? "buyer-lnd"})`);
    }
  } catch (err) {
    fail("LND buyer", `Unreachable: ${(err as Error).message}`, "Run: pnpm docker:up (wait ~30 s for LND to start)");
  }
}

async function checkLndSeller(): Promise<void> {
  try {
    const resp = await httpGet(`${LND_SELLER_URL}/v1/getinfo`);
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    const info = JSON.parse(resp.body) as { synced_to_chain?: boolean; alias?: string };

    if (!info.synced_to_chain) {
      fail("LND seller: sync", "NOT synced to chain", "Wait for seller-lnd to sync (docker logs agentswap-seller-lnd)");
    } else {
      pass("LND seller", `Reachable and synced (${info.alias ?? "seller-lnd"})`);
    }
  } catch (err) {
    fail("LND seller", `Unreachable: ${(err as Error).message}`, "Run: pnpm docker:up");
  }
}

async function checkEthContract(): Promise<void> {
  // Try env vars first (most reliable)
  const envAddress = process.env.ETH_HTLC_CONTRACT_ADDRESS
    || process.env.AGENTSWAP_HTLC_CONTRACT_ADDRESS;

  // Fall back to deployments JSON
  const deployPath = path.join(ROOT, "packages", "ethereum", "deployments", "localhost.json");
  let jsonAddress: string | undefined;

  if (fs.existsSync(deployPath)) {
    try {
      const records = JSON.parse(fs.readFileSync(deployPath, "utf8")) as Array<{ contract: string; address: string }>;
      const rec = records.find((r) => r.contract === "AgentSwapHTLC");
      jsonAddress = rec?.address;
    } catch {
      // ignore parse errors
    }
  }

  const address = envAddress || jsonAddress;

  if (!address) {
    fail(
      "ETH contract",
      "No deployed address found (checked env vars + packages/ethereum/deployments/localhost.json)",
      "Run: pnpm --filter @agentswap/ethereum deploy:agentswap"
    );
    return;
  }

  try {
    const code = await ethJsonRpc("eth_getCode", [address, "latest"]) as string;
    if (!code || code === "0x" || code === "0x0") {
      fail(
        "ETH contract",
        `No bytecode at ${address} — contract not deployed on this chain`,
        "Run: pnpm --filter @agentswap/ethereum deploy:agentswap"
      );
    } else {
      pass("ETH contract", `Deployed at ${address} (${((code.length - 2) / 2)} bytes)`);
    }
  } catch (err) {
    fail("ETH contract", `Could not query bytecode: ${(err as Error).message}`, "Check ETH_RPC_URL in .env");
  }
}

async function checkGanacheFunds(): Promise<void> {
  const BUYER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Ganache account[0]
  try {
    const hexBal = await ethJsonRpc("eth_getBalance", [BUYER_ADDR, "latest"]) as string;
    const wei = BigInt(hexBal);
    const eth = Number(wei) / 1e18;

    if (wei === 0n) {
      fail("Ganache: buyer funds", `Account ${BUYER_ADDR} has 0 ETH`, "Run: pnpm docker:down && pnpm docker:up (Ganache resets with 1000 ETH per account)");
    } else {
      pass("Ganache: buyer funds", `${eth.toFixed(2)} ETH at ${BUYER_ADDR}`);
    }
  } catch (err) {
    fail("Ganache", `Could not query balance: ${(err as Error).message}`, "Run: pnpm docker:up");
  }
}

async function checkClaudeApiKey(): Promise<void> {
  if (!ANTHROPIC_KEY) {
    fail("Anthropic API key", "ANTHROPIC_API_KEY is not set in environment", "Set ANTHROPIC_API_KEY in .env and re-run");
    return;
  }
  if (!ANTHROPIC_KEY.startsWith("sk-ant-")) {
    fail("Anthropic API key", "Key does not start with sk-ant- — may be invalid", "Check ANTHROPIC_API_KEY in .env");
    return;
  }

  try {
    const resp = await httpPost(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 16, messages: [{ role: "user", content: "Say: ok" }] },
      { timeoutMs: 15_000 }
    );
    const parsed = JSON.parse(resp.body) as { type?: string; error?: { type?: string; message?: string } };
    if (resp.status === 200 && parsed.type === "message") {
      pass("Anthropic API key", `Valid and responsive (status 200)`);
    } else if (resp.status === 401 || parsed.error?.type === "authentication_error") {
      fail("Anthropic API key", "401 Authentication error — key is invalid or expired", "Update ANTHROPIC_API_KEY in .env");
    } else if (resp.status === 429) {
      warn("Anthropic API key", "Rate limit hit during preflight check — key is valid but may be throttled during demo", "Wait 60 s before starting the demo");
    } else {
      warn("Anthropic API key", `Unexpected response: HTTP ${resp.status}`, "Check Anthropic status page");
    }
  } catch (err) {
    fail("Anthropic API key", `API call failed: ${(err as Error).message}`, "Check network connectivity to api.anthropic.com");
  }
}

async function checkExpressServer(): Promise<void> {
  try {
    const resp = await httpGet(`${SERVER_URL}/health`, { timeoutMs: 4000 });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    const health = JSON.parse(resp.body) as { status?: string; sseClients?: number; activeSwaps?: number };
    pass("Express server", `OK (status=${health.status}, sseClients=${health.sseClients}, activeSwaps=${health.activeSwaps})`);
  } catch (err) {
    fail(
      "Express server",
      `Not reachable at ${SERVER_URL}: ${(err as Error).message}`,
      "Run in a new terminal: pnpm --filter @agentswap/server dev   (or tsx packages/server/src/index.ts)"
    );
  }
}

async function checkDashboard(): Promise<void> {
  try {
    const resp = await httpGet(`${DASHBOARD_URL}`, { timeoutMs: 5000 });
    if (resp.status !== 200 && resp.status !== 304) throw new Error(`HTTP ${resp.status}`);
    pass("Dashboard", `Responding at ${DASHBOARD_URL} (HTTP ${resp.status})`);
  } catch (err) {
    fail(
      "Dashboard",
      `Not reachable at ${DASHBOARD_URL}: ${(err as Error).message}`,
      "Run: pnpm --filter @agentswap/dashboard dev  (or bash scripts/start-demo.sh)"
    );
  }
}

async function checkSseEndpoint(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (passed: boolean, detail: string, fix?: string) => {
      if (resolved) return;
      resolved = true;
      if (passed) {
        pass("SSE endpoint", detail);
      } else {
        fail("SSE endpoint", detail, fix);
      }
      resolve();
    };

    const req = http.request(
      { hostname: "localhost", port: 3001, path: "/events", method: "GET" },
      (res) => {
        const ct = res.headers["content-type"] ?? "";
        if (!ct.includes("text/event-stream")) {
          finish(false, `Wrong Content-Type: "${ct}" (expected text/event-stream)`, "Verify /events route in packages/server/src/routes/events.ts");
          res.destroy();
          return;
        }

        const chunks: string[] = [];
        const timer = setTimeout(() => {
          // 2 s elapsed — connection stayed open, that's a valid SSE stream
          const received = chunks.join("").trim();
          if (received.length > 0) {
            finish(true, `Streaming (Content-Type ok, received ${received.length} bytes in 2 s)`);
          } else {
            finish(true, `Streaming (Content-Type ok, no events in 2 s — expected during idle)`);
          }
          req.destroy();
        }, 2000);

        res.on("data", (d: Buffer) => {
          chunks.push(d.toString());
          if (!resolved) {
            clearTimeout(timer);
            finish(true, `Streaming events (first chunk arrived: ${d.toString().slice(0, 60).replace(/\n/g, "\\n")})`);
            req.destroy();
          }
        });
        res.on("error", () => {
          clearTimeout(timer);
          if (!resolved) finish(true, "SSE stream closed after 2 s (normal when idle)");
        });
      }
    );

    req.setTimeout(4000, () => {
      req.destroy();
      if (!resolved) finish(false, "Connection timed out after 4 s", "Start the Express server: pnpm --filter @agentswap/server dev");
    });
    req.on("error", (err: Error) => {
      if (!resolved) finish(false, `Connection error: ${err.message}`, "Ensure the Express server is running on port 3001");
    });
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wall = Date.now();

  console.log(`\n${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);
  console.log(`${B}${C}  AgentSwap — Pre-Demo Preflight Check${D}`);
  console.log(`${B}${C}  ${new Date().toLocaleString()}${D}`);
  console.log(`${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}\n`);

  const checks: Array<[string, () => Promise<void>]> = [
    ["Docker containers",        checkDockerContainers],
    ["LND buyer",                checkLndBuyer],
    ["LND seller",               checkLndSeller],
    ["Ethereum contract",        checkEthContract],
    ["Ganache funds",            checkGanacheFunds],
    ["Anthropic API key",        checkClaudeApiKey],
    ["Express server",           checkExpressServer],
    ["Dashboard",                checkDashboard],
    ["SSE endpoint",             checkSseEndpoint],
  ];

  for (const [, fn] of checks) {
    try {
      await fn();
    } catch (err) {
      console.log(`  ${R}✗${D} Unexpected error: ${(err as Error).message}`);
      results.push({ name: "unexpected", passed: false, detail: (err as Error).message });
    }
  }

  totalMs = Date.now() - wall;

  // ── Summary ──────────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);
  console.log(`${B}  Results:  ${G}${passed} passed${D}${B}  ${failed > 0 ? R : ""}${failed} failed${D}${B}  (${totalMs}ms)${D}`);

  if (failed === 0) {
    console.log(`\n  ${G}${B}🟢  GO — All checks passed. Demo environment is ready.${D}\n`);
    process.exit(0);
  } else {
    const blockers = results.filter((r) => !r.passed);
    console.log(`\n  ${R}${B}🔴  NO-GO — Fix the following before presenting:${D}`);
    blockers.forEach((b, i) => {
      console.log(`\n  ${R}${i + 1}. ${b.name}:${D} ${b.detail}`);
      if (b.fix) console.log(`     ${Y}▶ ${b.fix}${D}`);
    });
    console.log(`\n  ${Y}After fixing, run:${D} pnpm preflight\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Preflight check crashed:", err);
  process.exit(1);
});
