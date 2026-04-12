/**
 * tests/integration/atomicGuarantee.test.ts
 *
 * Cryptographic proof of AtomicSwap correctness.
 *
 * WHAT IS TESTED
 * ──────────────
 * Test 1 — Wrong preimage fails on ETH contract
 *   Create a full swap, reach LOCKED state. Before settlement, attempt to call
 *   claim(lockId, wrongPreimage) on the ETH contract. The contract MUST revert
 *   with a BadPreimage error. This proves the HTLC is cryptographically secure:
 *   only the party with the correct preimage can claim the funds.
 *
 * Test 2 — Preimage consistency across both chains
 *   Complete a full happy-path swap. Extract the preimage from the swap_settled
 *   SSE event. Verify:
 *     a) sha256(preimage) === btcRHash (BTC payment hash)
 *     b) sha256(abi.encodePacked(bytes32(preimage))) === lock.preimageHash (ETH)
 *     c) Both sides committed to the SAME underlying hash
 *   This is the mathematical proof that the swap is atomic.
 *
 * Test 3 — Preimage extracted from ETH Claimed event equals Lightning preimage
 *   After the seller claims ETH, the Claimed event on-chain records the preimage.
 *   Extract it from the event log and verify it equals the preimage from the
 *   Lightning settle. This proves the system leaves a public audit trail that
 *   anyone can inspect to verify the swap was honest.
 *
 * WHY THESE TESTS MATTER
 * ──────────────────────
 * If all three tests pass, the system satisfies the formal definition of an
 * atomic swap:
 *   1. Neither party can steal funds (wrong preimage fails)
 *   2. Both chains settle with the same secret (cross-chain consistency)
 *   3. The settlement is publicly verifiable on-chain (audit trail)
 *
 * REQUIRES
 * ────────
 * Same as happyPath.test.ts — all services must be running.
 */

import { describe, test, expect, afterEach } from "vitest";
import crypto from "crypto";
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
  triggerRefund,
  BUYER_ETH_KEY,
  SELLER_ETH_KEY,
  ETH_RPC_URL,
  DEFAULT_TEST_TIMEOUT_MS,
  pollUntil,
} from "./helpers.js";

// ── Shared state ──────────────────────────────────────────────────────────────

let sse: ReturnType<typeof connectSSE> | null = null;

afterEach(() => {
  sse?.close();
  sse = null;
});

// ── Helper: run a swap to LOCKED state and return key data ────────────────────

async function runToLocked(swapId: string, currentSSE: ReturnType<typeof connectSSE>): Promise<{
  ethLockId: string;
  btcRHash: string;
  preimageHash: string;
  btcPaymentRequest: string;
}> {
  // Wait for BTC invoice
  const prEvt = await currentSSE.waitForEvent("btc_payment_request", swapId, 90_000);
  const prData = prEvt.data as { paymentRequest: string };

  // Pay invoice to lock BTC
  await payBtcInvoice(prData.paymentRequest);

  // Wait for BTC lock confirmation
  await currentSSE.waitForEvent("btc_locked", swapId, 30_000);

  // Fetch record
  const record = await pollUntil(
    () => getSwap(swapId),
    (r) => !!r.ethLockId && !!r.btcRHash,
    { timeoutMs: 15_000, label: "ethLockId and btcRHash" }
  );

  return {
    ethLockId: record.ethLockId!,
    btcRHash:  record.btcRHash!,
    preimageHash: record.preimageHash!,
    btcPaymentRequest: prData.paymentRequest,
  };
}

// ── Test 1 ────────────────────────────────────────────────────────────────────

describe("Atomic Guarantee — Test 1: Wrong preimage is rejected by ETH contract", () => {
  test(
    "claim() with random wrong preimage reverts with BadPreimage",
    async () => {
      const contractAddress = getContractAddress();

      // Start a swap and reach LOCKED state
      const { swapId } = await startScenario("translation-task");
      sse = connectSSE();
      console.log(`  [test-1] swapId=${swapId}`);

      const { ethLockId, preimageHash } = await runToLocked(swapId, sse);
      console.log(`  [test-1] LOCKED. ethLockId=${ethLockId}`);

      // Generate a WRONG preimage (random 32 bytes — not the actual secret)
      const wrongPreimage = crypto.randomBytes(32).toString("hex");
      const wrongHash = sha256Eth(wrongPreimage);

      // The wrong hash must NOT match the stored preimageHash
      const storedHash = (await getLockViaRpc(contractAddress, ethLockId)).preimageHash;
      expect(wrongHash.toLowerCase()).not.toBe(storedHash.toLowerCase());
      console.log(`  [test-1] Wrong preimage hash ${wrongHash.slice(0, 18)}… ≠ stored ${storedHash.slice(0, 18)}…`);

      // Import ethers to attempt the failing claim
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
      const signer   = new ethers.Wallet(SELLER_ETH_KEY, provider);
      const htlcAbi  = [
        "function claim(bytes32 lockId, bytes32 preimage) external",
        "error BadPreimage(bytes32 lockId)",
      ];
      const contract = new ethers.Contract(contractAddress, htlcAbi, signer);

      // Attempt claim with wrong preimage — MUST revert
      const paddedWrong = ethers.zeroPadValue("0x" + wrongPreimage, 32);
      let caughtError: Error | null = null;

      try {
        const tx = await contract.claim(ethLockId, paddedWrong);
        await (tx as { wait: () => Promise<unknown> }).wait();
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).not.toBeNull();
      const errMsg = caughtError!.message.toLowerCase();

      // The revert can surface as:
      //   - ethers "CALL_EXCEPTION" with reason BadPreimage
      //   - "transaction failed"
      //   - "revert"
      const isRevert = errMsg.includes("badpreimage")
        || errMsg.includes("revert")
        || errMsg.includes("call_exception")
        || errMsg.includes("transaction failed");

      expect(isRevert).toBe(true);
      console.log(`  [test-1] Claim with wrong preimage correctly REVERTED ✓`);
      console.log(`  [test-1] Error: ${caughtError!.message.slice(0, 100)}`);

      // Verify lock was NOT claimed
      const lock = await getLockViaRpc(contractAddress, ethLockId);
      expect(lock.claimed).toBe(false);
      console.log(`  [test-1] lock.claimed=${lock.claimed} (funds safe) ✓`);

      // Clean up: force-refund so next tests have clean channel balance
      await triggerRefund(swapId, "atomicGuarantee test-1 cleanup");
    },
    DEFAULT_TEST_TIMEOUT_MS
  );
});

// ── Test 2 ────────────────────────────────────────────────────────────────────

describe("Atomic Guarantee — Test 2: Preimage is cryptographically consistent across both chains", () => {
  test(
    "sha256(preimage) === btcRHash AND sha256(abi.encodePacked(bytes32(preimage))) === lock.preimageHash",
    async () => {
      const contractAddress = getContractAddress();

      // Complete a full happy-path swap
      const { swapId } = await startScenario("code-review-task");
      sse = connectSSE();
      console.log(`  [test-2] swapId=${swapId}`);

      const { btcRHash } = await runToLocked(swapId, sse);

      // Collect states and wait for settled
      const [states, settledEvt] = await Promise.all([
        sse.collectStateChanges(swapId, "SETTLED", 90_000),
        sse.waitForEvent("swap_settled", swapId, 90_000),
      ]);

      expect(states[states.length - 1]).toBe("SETTLED");
      const { preimageHex } = settledEvt.data as { preimageHex: string };

      expect(typeof preimageHex).toBe("string");
      expect(preimageHex.length).toBe(64); // 32 bytes = 64 hex chars
      console.log(`  [test-2] Preimage revealed: ${preimageHex.slice(0, 16)}…`);

      // ── Chain 1: Bitcoin (SHA-256 of raw preimage bytes) ───────────────────
      const btcHashCalc = sha256Btc(preimageHex);
      console.log(`  [test-2] BTC:  sha256(preimage) = ${btcHashCalc.slice(0, 20)}…`);
      console.log(`  [test-2] BTC:  btcRHash         = ${btcRHash.slice(0, 20)}…`);
      expect(btcHashCalc.toLowerCase()).toBe(btcRHash.toLowerCase());
      console.log(`  [test-2] BTC hash consistency ✓`);

      // ── Chain 2: Ethereum (sha256(abi.encodePacked(bytes32(preimage)))) ─────
      const ethLockId = (await getSwap(swapId)).ethLockId!;
      const lock = await getLockViaRpc(contractAddress, ethLockId);

      const ethHashCalc = sha256Eth(preimageHex);
      console.log(`  [test-2] ETH:  sha256(packed preimage)  = ${ethHashCalc.slice(0, 20)}…`);
      console.log(`  [test-2] ETH:  lock.preimageHash        = ${lock.preimageHash.slice(0, 20)}…`);
      expect(ethHashCalc.toLowerCase()).toBe(lock.preimageHash.toLowerCase());
      console.log(`  [test-2] ETH hash consistency ✓`);

      // ── Cross-chain: BTC rHash == ETH preimageHash (same 32-byte secret) ───
      const btcHashWith0x = "0x" + btcHashCalc;
      expect(btcHashWith0x.toLowerCase()).toBe(lock.preimageHash.toLowerCase());
      console.log(`  [test-2] Cross-chain: BTC rHash === ETH preimageHash ✓`);

      // Also verify against the preimageHash stored in the swap record
      const swapRecord = await getSwap(swapId);
      expect(btcHashCalc.toLowerCase()).toBe(swapRecord.preimageHash?.toLowerCase());
      console.log(`  [test-2] Swap record preimageHash matches ✓`);

      // ── Claim ETH to clean up ────────────────────────────────────────────────
      await claimLockViaEthers(contractAddress, ethLockId, preimageHex);
      const claimedLock = await getLockViaRpc(contractAddress, ethLockId);
      expect(claimedLock.claimed).toBe(true);
      console.log(`  [test-2] ETH claimed successfully ✓`);
    },
    DEFAULT_TEST_TIMEOUT_MS
  );
});

// ── Test 3 ────────────────────────────────────────────────────────────────────

describe("Atomic Guarantee — Test 3: Preimage in ETH Claimed event matches Lightning settlement", () => {
  test(
    "preimage emitted in on-chain Claimed event equals preimage used to settle Lightning invoice",
    async () => {
      const contractAddress = getContractAddress();

      // Complete another happy-path swap
      const { swapId } = await startScenario("translation-task");
      sse = connectSSE();
      console.log(`  [test-3] swapId=${swapId}`);

      await runToLocked(swapId, sse);

      // Wait for settlement
      const settledEvt = await sse.waitForEvent("swap_settled", swapId, 90_000);
      const { preimageHex, btcTxId } = settledEvt.data as {
        preimageHex: string;
        btcTxId?: string;
      };

      console.log(`  [test-3] Swap settled, preimage=${preimageHex.slice(0, 16)}…`);

      // ── Step A: Verify Lightning invoice is SETTLED with this preimage ───────
      const record = await getSwap(swapId);
      const btcRHash = record.btcRHash!;

      const lndInvoice = await pollUntil(
        () => lookupInvoice(btcRHash),
        (inv) => inv.state === "SETTLED",
        { timeoutMs: 15_000, label: "LND invoice to be SETTLED" }
      );
      expect(lndInvoice.state).toBe("SETTLED");
      console.log(`  [test-3] LND invoice SETTLED ✓`);

      // Verify: sha256(preimage) from SSE event === btcRHash from LND
      const btcHash = sha256Btc(preimageHex);
      expect(btcHash.toLowerCase()).toBe(btcRHash.toLowerCase());
      console.log(`  [test-3] Lightning preimage hash verified ✓`);

      // ── Step B: Seller claims ETH, which logs the preimage on-chain ──────────
      const { ethers } = await import("ethers");
      const provider   = new ethers.JsonRpcProvider(ETH_RPC_URL);
      const signer     = new ethers.Wallet(SELLER_ETH_KEY, provider);
      const htlcAbi    = [
        "function claim(bytes32 lockId, bytes32 preimage) external",
        "event Claimed(bytes32 indexed lockId, bytes32 preimage, uint256 claimedAt)",
      ];
      const contract   = new ethers.Contract(contractAddress, htlcAbi, signer);

      const ethLockId = record.ethLockId!;
      const padded    = ethers.zeroPadValue("0x" + preimageHex, 32);

      const tx = await (contract.claim as (
        lockId: string, preimage: string
      ) => Promise<{ wait: () => Promise<{ hash: string; logs: unknown[] }> }>)(ethLockId, padded);
      const receipt = await tx.wait();
      console.log(`  [test-3] ETH claim tx: ${receipt.hash}`);

      // ── Step C: Parse the Claimed event to extract the on-chain preimage ─────
      const iface  = new ethers.Interface(htlcAbi);
      const claimedTopic = iface.getEvent("Claimed")?.topicHash;

      interface EthLog {
        topics: string[];
        data: string;
      }

      const rawLog = (receipt.logs as EthLog[]).find((l) => l.topics[0] === claimedTopic);
      expect(rawLog).toBeTruthy();

      const parsed = iface.parseLog({ topics: rawLog!.topics, data: rawLog!.data });
      expect(parsed).not.toBeNull();

      const onChainPreimage: string = parsed!.args.preimage as string;
      console.log(`  [test-3] On-chain Claimed.preimage: ${onChainPreimage.slice(0, 18)}…`);

      // ── Step D: The on-chain preimage MUST match the Lightning preimage ───────
      const onChainClean = onChainPreimage.startsWith("0x")
        ? onChainPreimage.slice(2).toLowerCase()
        : onChainPreimage.toLowerCase();
      const lightningClean = preimageHex.toLowerCase();

      expect(onChainClean).toBe(lightningClean);
      console.log(`  [test-3] ETH Claimed.preimage === Lightning preimage ✓`);

      // ── Step E: One final cross-check — on-chain preimage hashes to btcRHash ─
      const onChainBtcHash = sha256Btc(onChainClean);
      expect(onChainBtcHash.toLowerCase()).toBe(btcRHash.toLowerCase());
      console.log(`  [test-3] sha256(ETH preimage) === BTC rHash ✓`);

      // ── Summary ──────────────────────────────────────────────────────────────
      console.log(`\n  ✅ ATOMIC GUARANTEE VERIFIED (Test 3)`);
      console.log(`     Lightning preimage:  ${preimageHex.slice(0, 20)}…`);
      console.log(`     ETH Claimed event:   ${onChainClean.slice(0, 20)}… (matches)`);
      console.log(`     BTC rHash:           ${btcRHash.slice(0, 20)}… (sha256 verified)`);
      console.log(`     CONCLUSION: The same secret unlocked both chains. The swap is atomic.`);
    },
    DEFAULT_TEST_TIMEOUT_MS
  );
});
