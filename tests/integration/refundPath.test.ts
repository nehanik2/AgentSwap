/**
 * tests/integration/refundPath.test.ts
 *
 * Full end-to-end integration test for the AgentSwap REFUND path.
 *
 * WHAT IS TESTED
 * ──────────────
 * 1. "bad-delivery-demo" scenario reaches REFUNDED state.
 * 2. Arbitrator's quality score is below the 70/100 threshold.
 * 3. BTC HODL invoice is CANCELLED on the seller's LND node.
 * 4. ETH contract lock can be refunded once timelock expires.
 * 5. After Ganache time-warp and refund tx: lock.refunded === true.
 * 6. Buyer's ETH balance increases by the lock amount (minus gas).
 *
 * DESIGN NOTE — TIME WARP
 * ───────────────────────
 * The ETH HTLC uses a 24-hour timelock. We can't wait 24 hours in CI.
 * Instead we use Ganache's evm_increaseTime JSON-RPC to fast-forward the
 * chain's clock by 25 hours, making the lock immediately refundable.
 * This is ONLY possible with Ganache in test mode — never on mainnet.
 *
 * REQUIRES
 * ────────
 * Same as happyPath.test.ts — all services must be running.
 */

import { describe, test, expect, afterAll } from "vitest";
import {
  startScenario,
  connectSSE,
  payBtcInvoice,
  lookupInvoice,
  getLockViaRpc,
  refundLockViaEthers,
  getSwap,
  getEthBalance,
  advanceGanacheTime,
  getContractAddress,
  BUYER_ETH_ADDRESS,
  DEFAULT_TEST_TIMEOUT_MS,
  pollUntil,
} from "./helpers.js";

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Refund Path — bad-delivery-demo scenario", () => {
  let sse: ReturnType<typeof connectSSE>;

  afterAll(() => {
    sse?.close();
  });

  test(
    "bad delivery: arbitrator rejects → BTC invoice cancelled → ETH refunded after timelock",
    async () => {
      const contractAddress = getContractAddress();

      // ── 1. Start the bad-delivery scenario ─────────────────────────────────
      const { swapId } = await startScenario("bad-delivery-demo");
      expect(typeof swapId).toBe("string");
      console.log(`  [test] swapId=${swapId}`);

      // ── 2. Connect to SSE ───────────────────────────────────────────────────
      sse = connectSSE();

      // ── 3. Wait for BTC invoice to be created (after negotiation + ETH lock) ─
      console.log("  [test] Waiting for BTC payment request…");
      const prEvent = await sse.waitForEvent("btc_payment_request", swapId, 90_000);
      const prData = prEvent.data as { paymentRequest: string };
      expect(prData.paymentRequest).toMatch(/^lnbcrt/);
      console.log(`  [test] BTC invoice ready`);

      // ── 4. Pay the invoice (BTC gets locked in HTLC) ───────────────────────
      console.log("  [test] Buyer paying Lightning invoice…");
      await payBtcInvoice(prData.paymentRequest);
      console.log("  [test] BTC payment submitted");

      // ── 5. Wait for BTC locked confirmation ─────────────────────────────────
      await sse.waitForEvent("btc_locked", swapId, 30_000);
      console.log("  [test] BTC locked ✓");

      // ── 6. Collect states until REFUNDED ────────────────────────────────────
      console.log("  [test] Waiting for arbitrator rejection → REFUNDED…");
      const statesPromise = sse.collectStateChanges(swapId, "REFUNDED", 90_000);
      const refundedPromise = sse.waitForEvent("swap_refunded", swapId, 90_000);

      const [states, refundedEvt] = await Promise.all([statesPromise, refundedPromise]);
      const refundedData = refundedEvt.data as { swapId: string; reason: string };

      console.log(`  [test] States observed: ${states.join(" → ")}`);
      expect(states).toContain("EVALUATING");
      expect(states[states.length - 1]).toBe("REFUNDED");

      // ── 7. Verify arbitrator verdict quality score < 70 ─────────────────────
      // Poll GET /swap/:id until qualityScore is populated
      const record = await pollUntil(
        () => getSwap(swapId),
        (r) => typeof r.qualityScore === "number",
        { timeoutMs: 15_000, label: "qualityScore to be set" }
      );

      expect(record.state).toBe("REFUNDED");
      expect(record.qualityScore).toBeDefined();
      expect(record.qualityScore!).toBeLessThan(70);
      console.log(`  [test] Arbitrator score: ${record.qualityScore}/100 (< 70 threshold) ✓`);
      console.log(`  [test] Rejection reason: ${record.arbitratorReasoning?.slice(0, 80)}…`);
      console.log(`  [test] Refund reason: ${refundedData.reason.slice(0, 80)}…`);

      // ── 8. Verify BTC invoice is CANCELLED on seller's LND ──────────────────
      const btcRHash = record.btcRHash!;
      expect(btcRHash).toBeTruthy();

      console.log("  [test] Checking LND invoice state…");
      // Allow a small delay for the cancel to propagate
      const lndInvoice = await pollUntil(
        () => lookupInvoice(btcRHash),
        (inv) => inv.state === "CANCELED" || inv.state === "SETTLED",
        { timeoutMs: 20_000, intervalMs: 2_000, label: "LND invoice to be CANCELED" }
      );

      expect(lndInvoice.state).toBe("CANCELED");
      console.log(`  [test] LND invoice state: ${lndInvoice.state} ✓`);

      // ── 9. Verify ETH lock is NOT yet refunded (timelock still active) ───────
      const ethLockId = record.ethLockId!;
      expect(ethLockId).toBeTruthy();

      const lockBefore = await getLockViaRpc(contractAddress, ethLockId);
      expect(lockBefore.claimed).toBe(false);
      expect(lockBefore.refunded).toBe(false);
      expect(lockBefore.amount).toBeGreaterThan(0n);
      console.log(`  [test] ETH lock exists, not yet refunded (timelock pending) ✓`);

      // ── 10. Fast-forward Ganache by 25 hours (past the 24h ETH timelock) ────
      console.log("  [test] Fast-forwarding Ganache time by 25 hours…");
      await advanceGanacheTime(25 * 3600);
      console.log("  [test] Time warp complete");

      // ── 11. Capture buyer's ETH balance before refund ────────────────────────
      const balBefore = await getEthBalance(BUYER_ETH_ADDRESS);
      console.log(`  [test] Buyer ETH balance before refund: ${balBefore} wei`);

      // ── 12. Call refund() on the ETH contract ────────────────────────────────
      console.log("  [test] Calling ETH contract refund()…");
      const refundTxHash = await refundLockViaEthers(contractAddress, ethLockId);
      console.log(`  [test] Refund tx: ${refundTxHash}`);

      // ── 13. Verify lock is now refunded ──────────────────────────────────────
      const lockAfter = await getLockViaRpc(contractAddress, ethLockId);
      expect(lockAfter.claimed).toBe(false);
      expect(lockAfter.refunded).toBe(true);
      console.log(`  [test] ETH lock.refunded=${lockAfter.refunded} ✓`);

      // ── 14. Verify buyer's ETH balance increased ─────────────────────────────
      const balAfter = await getEthBalance(BUYER_ETH_ADDRESS);
      const increase = balAfter - balBefore;

      // The buyer should have received back most of the lock amount
      // (balance increase ≈ lock amount minus gas costs)
      const lockAmount = lockBefore.amount;
      expect(increase).toBeGreaterThan(0n);
      expect(increase).toBeLessThanOrEqual(lockAmount); // can't exceed lock amount

      // Expect at least 95% of lock amount returned (gas should be < 5%)
      const expectedMin = (lockAmount * 95n) / 100n;
      expect(increase).toBeGreaterThan(expectedMin);

      console.log(`  [test] Lock amount: ${lockAmount} wei`);
      console.log(`  [test] Balance increase: ${increase} wei (${Number(increase * 1000n / lockAmount) / 10}% of lock) ✓`);

      // ── Summary ─────────────────────────────────────────────────────────────
      console.log(`\n  ✅ REFUND PATH COMPLETE`);
      console.log(`     States:           ${states.join(" → ")}`);
      console.log(`     Quality score:    ${record.qualityScore}/100 (rejected)`);
      console.log(`     BTC invoice:      CANCELED`);
      console.log(`     ETH lock:         REFUNDED`);
      console.log(`     Buyer recovered:  ${Number(increase) / 1e18} ETH`);
    },
    DEFAULT_TEST_TIMEOUT_MS
  );
});
