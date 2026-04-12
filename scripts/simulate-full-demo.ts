#!/usr/bin/env tsx
/**
 * scripts/simulate-full-demo.ts
 *
 * Runs the complete AgentSwap demo automatically and produces a timing report.
 * No human interaction required — used to verify demo timing before presenting.
 *
 * WHAT IT DOES
 * ────────────
 * 1. Runs the HAPPY PATH (translation-task):
 *    Records timestamp at each phase transition.
 *    Prints a breakdown: Negotiation | ETH lock | BTC lock | Evaluation | Settlement
 *
 * 2. Runs the BAD DELIVERY PATH (bad-delivery-demo):
 *    Records timestamp at each phase transition.
 *    Prints: Negotiation | ETH lock | BTC lock | Evaluation | Refund
 *
 * 3. Prints a final DEMO READY report with go/no-go.
 *
 * USAGE
 *   pnpm simulate-demo
 *   tsx scripts/simulate-full-demo.ts
 *
 * REQUIRES
 *   • Express server running on port 3001
 *   • All Docker services running
 *   • ANTHROPIC_API_KEY set
 */

// Load .env and .env.local if present (best-effort; no hard dependency on dotenv)
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv") as { config: (opts?: { path?: string; override?: boolean }) => void };
  dotenv.config();
  dotenv.config({ path: ".env.local", override: false });
} catch { /* dotenv not required — env vars may already be set */ }

import http from "http";
import https from "https";

// ── ANSI ──────────────────────────────────────────────────────────────────────

const G = "\x1b[32m"; const R = "\x1b[31m"; const Y = "\x1b[33m";
const C = "\x1b[36m"; const B = "\x1b[1m";  const D = "\x1b[0m";
const DIM = "\x1b[2m";

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL    = process.env.SERVER_URL   ?? "http://localhost:3001";
const BUYER_LND_URL = process.env.BUYER_LND_URL ?? "https://localhost:8080";

const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function httpPost(url: string, body: unknown, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod: typeof https = parsed.protocol === "https:" ? https : (http as unknown as typeof https);
    const agent: https.Agent | undefined = parsed.protocol === "https:" ? INSECURE_AGENT : undefined;
    const req = mod.request(
      {
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (d: Buffer) => { data += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`POST ${url} timeout`)); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── SSE client ────────────────────────────────────────────────────────────────

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function openSSE(url = `${SERVER_URL}/events`): {
  waitFor(type: string, swapId: string, ms: number): Promise<SSEEvent>;
  collectStates(swapId: string, until: string, ms: number): Promise<Array<{ state: string; t: number }>>;
  close(): void;
} {
  type Handler = (e: SSEEvent) => void;
  const listeners = new Map<string, Handler[]>();
  let req: http.ClientRequest;

  function on(type: string, h: Handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(h);
  }
  function off(type: string, h: Handler) {
    const list = listeners.get(type) ?? [];
    const i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
  }
  function emit(evt: SSEEvent) {
    (listeners.get(evt.type) ?? []).forEach((h) => h(evt));
    (listeners.get("*") ?? []).forEach((h) => h(evt));
  }

  const parsed = new URL(url);
  req = http.request(
    { hostname: parsed.hostname, port: Number(parsed.port) || 3001, path: "/events", method: "GET" },
    (res) => {
      let buf = ""; let type = ""; let data = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { type = line.slice(7).trim(); }
          else if (line.startsWith("data: ")) { data = line.slice(6); }
          else if (line === "" || line === "\r") {
            if (data) {
              try { emit({ type: type || "message", data: JSON.parse(data) as Record<string, unknown> }); }
              catch { /* ignore */ }
              type = ""; data = "";
            }
          }
        }
      });
    }
  );
  req.on("error", () => {});
  req.end();

  return {
    waitFor(type: string, swapId: string, ms: number): Promise<SSEEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(type, h); reject(new Error(`Timeout: ${type} for ${swapId}`)); }, ms);
        function h(e: SSEEvent) {
          if ((e.data as { swapId?: string }).swapId !== swapId) return;
          clearTimeout(timer); off(type, h); resolve(e);
        }
        on(type, h);
      });
    },

    collectStates(swapId: string, until: string, ms: number): Promise<Array<{ state: string; t: number }>> {
      return new Promise((resolve, reject) => {
        const transitions: Array<{ state: string; t: number }> = [];
        const timer = setTimeout(() => {
          off("state_change", h);
          reject(new Error(`Timeout waiting for state "${until}". Saw: ${transitions.map((t) => t.state).join(",")}`));
        }, ms);
        function h(e: SSEEvent) {
          const d = e.data as { swapId?: string; newState?: string };
          if (d?.swapId !== swapId) return;
          if (d.newState) transitions.push({ state: d.newState, t: Date.now() });
          if (d.newState === until || d.newState === "REFUNDED" || d.newState === "SETTLED") {
            clearTimeout(timer); off("state_change", h); resolve(transitions);
          }
        }
        on("state_change", h);
      });
    },

    close() { req.destroy(); },
  };
}

// ── LND pay invoice ───────────────────────────────────────────────────────────

async function payInvoice(paymentRequest: string): Promise<void> {
  await httpPost(`${BUYER_LND_URL}/v2/router/send`, {
    payment_request: paymentRequest,
    timeout_seconds: 60,
    fee_limit_sat: 1_000,
    no_inflight_updates: true,
  }, 65_000);
}

// ── Run one scenario ──────────────────────────────────────────────────────────

interface PhaseTimings {
  scenarioId: string;
  expectedOutcome: "SETTLED" | "REFUNDED";
  start: number;
  negotiationDone?: number;
  ethLocked?: number;
  btcLocked?: number;
  evaluationStart?: number;
  terminal?: number;
  terminalState?: string;
  error?: string;
}

async function runScenario(
  scenarioId: string,
  expectedOutcome: "SETTLED" | "REFUNDED",
  sse: ReturnType<typeof openSSE>
): Promise<PhaseTimings> {
  const timings: PhaseTimings = { scenarioId, expectedOutcome, start: Date.now() };

  try {
    // Start scenario
    const resp = await httpPost(`${SERVER_URL}/demo/start-scenario`, { scenarioId });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}: ${resp.body}`);
    const { swapId } = JSON.parse(resp.body) as { swapId: string };
    console.log(`    ${DIM}swapId: ${swapId}${D}`);

    // Subscribe to events in parallel
    const statesPromise = sse.collectStates(swapId, expectedOutcome, 120_000);
    const terminalEvtPromise = sse.waitFor(
      expectedOutcome === "SETTLED" ? "swap_settled" : "swap_refunded",
      swapId,
      120_000
    );

    // Wait for BTC payment request
    const prEvt = await sse.waitFor("btc_payment_request", swapId, 90_000);
    timings.negotiationDone = Date.now();
    console.log(`    ${DIM}BTC invoice ready — paying…${D}`);

    const prData = prEvt.data as { paymentRequest: string };
    await payInvoice(prData.paymentRequest);

    // Wait for BTC locked
    await sse.waitFor("btc_locked", swapId, 30_000);
    timings.btcLocked = Date.now();
    console.log(`    ${DIM}BTC locked${D}`);

    // Wait for evaluation start
    await sse.waitFor("deliverable_submitted", swapId, 60_000);
    timings.evaluationStart = Date.now();
    console.log(`    ${DIM}Deliverable submitted — arbitrator evaluating…${D}`);

    // Wait for terminal event
    await terminalEvtPromise;
    timings.terminal = Date.now();

    // Collect states for verification
    const states = await statesPromise.catch(() => [] as Array<{ state: string; t: number }>);
    const lockState = states.find((s) => s.state === "LOCKED");
    if (lockState) timings.ethLocked = lockState.t;
    timings.terminalState = states[states.length - 1]?.state ?? expectedOutcome;
    console.log(`    ${DIM}Terminal state: ${timings.terminalState}${D}`);

  } catch (err) {
    timings.error = (err as Error).message;
  }

  return timings;
}

// ── Print timing report ───────────────────────────────────────────────────────

function printTimings(t: PhaseTimings, label: string): void {
  const total = t.terminal ? (t.terminal - t.start) / 1000 : null;
  const ok = !t.error && t.terminalState === t.expectedOutcome;

  console.log(`\n  ${B}${ok ? G : R}${label}${D}`);

  if (t.error) {
    console.log(`  ${R}ERROR: ${t.error}${D}`);
    return;
  }

  const neg  = t.negotiationDone ? ((t.negotiationDone - t.start) / 1000).toFixed(1) : "?";
  const eth  = t.ethLocked && t.negotiationDone ? ((t.ethLocked - t.negotiationDone) / 1000).toFixed(1) : "?";
  const btc  = t.btcLocked && t.negotiationDone ? ((t.btcLocked - t.negotiationDone) / 1000).toFixed(1) : "?";
  const eval_ = t.evaluationStart && t.btcLocked ? ((t.evaluationStart - t.btcLocked) / 1000).toFixed(1) : "?";
  const settle = t.terminal && t.evaluationStart ? ((t.terminal - t.evaluationStart) / 1000).toFixed(1) : "?";
  const totalStr = total !== null ? total.toFixed(1) + "s" : "?";

  console.log(`  ${DIM}  Negotiation:  ${neg}s${D}`);
  console.log(`  ${DIM}  ETH lock:     ${eth}s${D}`);
  console.log(`  ${DIM}  BTC lock:     ${btc}s${D}`);
  console.log(`  ${DIM}  Evaluation:   ${eval_}s${D}`);
  console.log(`  ${DIM}  Settlement:   ${settle}s${D}`);
  console.log(`  ${B}  Total:        ${totalStr}${D}  ${ok ? G + "✓" + D : R + "✗ WRONG STATE: " + t.terminalState + D}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wall = Date.now();

  console.log(`\n${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);
  console.log(`${B}${C}  AgentSwap — Full Demo Simulation${D}`);
  console.log(`${B}${C}  ${new Date().toLocaleString()}${D}`);
  console.log(`${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);
  console.log(`\n  ${Y}This script runs both demo paths automatically.${D}`);
  console.log(`  ${Y}Ensure the server is running before continuing.${D}\n`);

  // Quick server check
  try {
    const hc = await httpPost(`${SERVER_URL}/health`, {}, 5_000).catch(() => null);
    if (!hc || hc.status !== 200) throw new Error("server not responding");
    console.log(`  ${G}Server OK${D}  ${SERVER_URL}/health\n`);
  } catch {
    console.error(`  ${R}Server not reachable at ${SERVER_URL}${D}`);
    console.error(`  ${Y}Run: pnpm --filter @agentswap/server dev${D}\n`);
    process.exit(1);
  }

  // Open one SSE connection — reused for both scenarios so we don't miss events
  const sse = openSSE();

  // ── Scenario 1: Happy path ────────────────────────────────────────────────
  console.log(`\n${B}${C}── Scenario 1: Happy Path (translation-task) ──${D}`);
  const happyTimings = await runScenario("translation-task", "SETTLED", sse);

  // ── Scenario 2: Refund path ───────────────────────────────────────────────
  // Brief pause to let SSE stream clear
  await new Promise((r) => setTimeout(r, 2_000));

  console.log(`\n${B}${C}── Scenario 2: Refund Path (bad-delivery-demo) ──${D}`);
  const refundTimings = await runScenario("bad-delivery-demo", "REFUNDED", sse);

  sse.close();

  // ── Final report ─────────────────────────────────────────────────────────
  const wallSec = (Date.now() - wall) / 1000;

  console.log(`\n${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);
  console.log(`${B}${C}  Timing Report${D}`);
  console.log(`${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);

  printTimings(happyTimings, "Happy Path (translation-task) → SETTLED");
  printTimings(refundTimings, "Refund Path (bad-delivery-demo) → REFUNDED");

  const happyOk  = !happyTimings.error  && happyTimings.terminalState  === "SETTLED";
  const refundOk = !refundTimings.error && refundTimings.terminalState === "REFUNDED";
  const bothOk   = happyOk && refundOk;

  const happyTotal  = happyTimings.terminal  ? ((happyTimings.terminal  - happyTimings.start)  / 1000).toFixed(0) + "s" : "ERROR";
  const refundTotal = refundTimings.terminal ? ((refundTimings.terminal - refundTimings.start) / 1000).toFixed(0) + "s" : "ERROR";

  console.log(`\n${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${D}`);

  if (bothOk) {
    console.log(`\n  ${B}${G}🟢  DEMO READY${D}`);
    console.log(`     Happy path:   ${happyTotal}`);
    console.log(`     Refund path:  ${refundTotal}`);
    console.log(`     Both paths nominal. Safe to present.\n`);
  } else {
    console.log(`\n  ${B}${R}🔴  DEMO NOT READY${D}`);
    if (!happyOk)  console.log(`  ${R}  ✗ Happy path failed${D} — ${happyTimings.error ?? "wrong state: " + happyTimings.terminalState}`);
    if (!refundOk) console.log(`  ${R}  ✗ Refund path failed${D} — ${refundTimings.error ?? "wrong state: " + refundTimings.terminalState}`);
    console.log(`\n  ${Y}  Run: bash scripts/reset-demo-env.sh${D}\n`);
    process.exit(1);
  }

  console.log(`  ${DIM}Total simulation time: ${wallSec.toFixed(1)}s${D}\n`);
}

main().catch((err) => {
  console.error("simulate-full-demo crashed:", err);
  process.exit(1);
});
