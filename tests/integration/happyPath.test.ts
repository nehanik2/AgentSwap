/**
 * tests/integration/happyPath.test.ts
 *
 * Full end-to-end integration test for the AgentSwap happy path.
 *
 * WHAT IS TESTED
 * ──────────────
 * 1. Swap reaches SETTLED state via the "translation-task" demo scenario.
 * 2. SSE state transitions arrive in the correct order.
 * 3. BTC HTLC was created (HODL invoice exists on seller LND).
 * 4. ETH HTLC was locked (contract lock exists with correct amount).
 * 5. After settlement the preimage is broadcast on Lightning (invoice SETTLED).
 * 6. Seller can claim ETH using the revealed preimage.
 * 7. After claim: ETH lock.claimed === true.
 * 8. Cross-chain hash consistency: sha256(preimage) matches preimageHash on BOTH chains.
 * 9. Total swap time is under 120 seconds.
 *
 * REQUIRES
 * ────────
 * • Docker stack running (pnpm docker:up)
 * • Express server running on port 3001
 * • Lightning channel open with ≥50 000 sats local balance (buyer side)
 * • ETH HTLC contract deployed (env var ETH_HTLC_CONTRACT_ADDRESS set)
 * • ANTHROPIC_API_KEY set
 *
 * Run with: pnpm test:integration
 */

import { describe, test, expect, afterAll } from "vitest";
import {
  startScenario,
  connectSSE,
  payBtcInvoice,
  lookupInvoice,
  getLockViaRpc,
  claimLockViaEthers,
  getSwap,
  sha256Btc,
  sha256Eth,
  getContractAddress,
  DEFAULT_TEST_TIMEOUT_MS,
} from "./helpers.js";

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Happy Path — translation-task scenario", () => {
  let sse: ReturnType<typeof connectSSE>;

  afterAll(() => {
    sse?.close();
  });

  test(
    "full atomic swap: NEGOTIATING → LOCKED → EVALUATING → APPROVED → SETTLED, " +
    "preimage consistent across both chains, under 120 seconds",
    async () => {
      const swapStartMs = Date.now();

      // ── 1. Start the demo scenario ──────────────────────────────────────────
      const { swapId } = await startScenario("translation-task");
      expect(typeof swapId).toBe("string");
      expect(swapId.length).toBeGreaterThan(0);
      console.log(`  [test] swapId=${swapId}`);

      // ── 2. Connect to SSE immediately ───────────────────────────────────────
      // Must be established BEFORE the btc_payment_request event fires.
      // Negotiation (several LLM calls) gives us a comfortable window.
      sse = connectSSE();

      // ── 3. Wait for BTC HODL invoice to be created ──────────────────────────
      console.log("  [test] Waiting for BTC payment request (includes negotiation + ETH lock)…");
      const prEvent = await sse.waitForEvent("btc_payment_request", swapId, 90_000);
      const prData = prEvent.data as { swapId: string; paymentRequest: string; expiryAt: string };

      expect(prData.paymentRequest).toMatch(/^lnbcrt/); // regtest BOLT-11 prefix
      console.log(`  [test] BTC invoice ready: ${prData.paymentRequest.slice(0, 40)}…`);

      // ── 4. Pay the invoice from buyer's LND ─────────────────────────────────
      console.log("  [test] Paying Lightning invoice from buyer's LND…");
      const btcPayResult = await payBtcInvoice(prData.paymentRequest);
      console.log(`  [test] BTC payment submitted (hash=${btcPayResult.paymentHash?.slice(0, 16) ?? "unknown"}…)`);

      // ── 5. Collect all state transitions until SETTLED ──────────────────────
      console.log("  [test] Collecting state transitions…");
      const statesPromise = sse.collectStateChanges(swapId, "SETTLED", 90_000);

      // Also watch for the settled event to capture the preimage
      const settledPromise = sse.waitForEvent("swap_settled", swapId, 90_000);

      const [states, settledEvt] = await Promise.all([statesPromise, settledPromise]);
      const settledData = settledEvt.data as { swapId: string; preimageHex: string; btcTxId?: string };

      console.log(`  [test] States observed: ${states.join(" → ")}`);
      expect(states).toContain("LOCKED");
      expect(states).toContain("EVALUATING");
      expect(states[states.length - 1]).toBe("SETTLED");

      // Verify ordering: LOCKED must precede EVALUATING, which must precede SETTLED
      const iLocked    = states.indexOf("LOCKED");
      const iEval      = states.indexOf("EVALUATING");
      const iSettled   = states.indexOf("SETTLED");
      expect(iLocked).toBeLessThan(iEval);
      expect(iEval).toBeLessThan(iSettled);

      // ── 6. Check total elapsed time ─────────────────────────────────────────
      const elapsedSec = (Date.now() - swapStartMs) / 1000;
      console.log(`  [test] Total time to SETTLED: ${elapsedSec.toFixed(1)}s`);
      expect(elapsedSec).toBeLessThan(120);

      // ── 7. Verify final swap record via REST ────────────────────────────────
      const record = await getSwap(swapId);
      expect(record.state).toBe("SETTLED");
      expect(record.ethLockId).toBeTruthy();
      expect(record.btcRHash).toBeTruthy();
      expect(record.preimageHash).toBeTruthy();
      expect(record.ethReceipt?.contractAddress).toBeTruthy();

      const { ethLockId, btcRHash, preimageHash, ethReceipt } = record;
      const contractAddress = ethReceipt?.contractAddress ?? getContractAddress();

      console.log(`  [test] ethLockId=${ethLockId}`);
      console.log(`  [test] btcRHash=${btcRHash}`);
      console.log(`  [test] preimageHash=${preimageHash}`);
      console.log(`  [test] preimageHex from event=${settledData.preimageHex.slice(0, 16)}…`);

      // ── 8. Verify LND invoice state is SETTLED ──────────────────────────────
      console.log("  [test] Looking up Lightning invoice on seller LND…");
      const invoice = await lookupInvoice(btcRHash!);
      expect(invoice.state).toBe("SETTLED");
      console.log(`  [test] LND invoice state: ${invoice.state} ✓`);

      // ── 9. Verify ETH lock exists and is NOT yet claimed (seller must claim) ─
      const lockBefore = await getLockViaRpc(contractAddress, ethLockId!);
      expect(lockBefore.claimed).toBe(false);
      expect(lockBefore.refunded).toBe(false);
      expect(lockBefore.amount).toBeGreaterThan(0n);
      console.log(`  [test] ETH lock amount=${lockBefore.amount} wei, claimed=${lockBefore.claimed} ✓`);

      // ── 10. Verify cross-chain preimage consistency BEFORE claiming ──────────
      const { preimageHex } = settledData;
      expect(preimageHex).toBeTruthy();
      expect(preimageHex.length).toBe(64); // 32 bytes as hex

      // BTC: SHA256(preimage_bytes) === btcRHash (payment hash stored on LND)
      const btcHashCalc = sha256Btc(preimageHex);
      expect(btcHashCalc).toBe(btcRHash!.toLowerCase());
      console.log(`  [test] BTC hash consistency: sha256(preimage) = ${btcHashCalc.slice(0, 16)}… ✓`);

      // ETH: sha256(abi.encodePacked(bytes32(preimage))) === lock.preimageHash
      const ethHashCalc = sha256Eth(preimageHex);
      const normalizedLockHash = lockBefore.preimageHash.toLowerCase();
      expect(ethHashCalc.toLowerCase()).toBe(normalizedLockHash);
      console.log(`  [test] ETH hash consistency: sha256(preimage) = ${ethHashCalc.slice(0, 18)}… ✓`);

      // Both chains committed to the SAME hash
      const btcHashHex  = "0x" + btcHashCalc;
      expect(btcHashHex.toLowerCase()).toBe(normalizedLockHash);
      console.log(`  [test] Cross-chain hash matches: BTC rHash == ETH preimageHash ✓`);

      // ── 11. Seller claims ETH using the revealed preimage ───────────────────
      console.log("  [test] Seller claiming ETH…");
      const claimTxHash = await claimLockViaEthers(contractAddress, ethLockId!, preimageHex);
      console.log(`  [test] ETH claim tx: ${claimTxHash}`);

      // ── 12. Verify lock is now claimed ──────────────────────────────────────
      const lockAfter = await getLockViaRpc(contractAddress, ethLockId!);
      expect(lockAfter.claimed).toBe(true);
      expect(lockAfter.refunded).toBe(false);
      console.log(`  [test] ETH lock.claimed=${lockAfter.claimed} ✓`);

      // ── Summary ─────────────────────────────────────────────────────────────
      console.log(`\n  ✅ HAPPY PATH COMPLETE`);
      console.log(`     States:       ${states.join(" → ")}`);
      console.log(`     Total time:   ${elapsedSec.toFixed(1)}s`);
      console.log(`     BTC invoice:  SETTLED`);
      console.log(`     ETH lock:     CLAIMED`);
      console.log(`     Atomicity:    VERIFIED (same preimage unlocked both chains)`);
    },
    DEFAULT_TEST_TIMEOUT_MS
  );
});
