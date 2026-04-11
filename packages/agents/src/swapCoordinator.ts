/**
 * packages/agents/src/swapCoordinator.ts
 *
 * SwapCoordinator — manages the full lifecycle of a cross-chain atomic swap.
 *
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *   SwapCoordinator
 *       │
 *       ├── lndClient (LNDClient)          seller's LND node
 *       │       creates/settles/cancels the BTC HODL invoice
 *       │
 *       └── htlcClient (HTLCClient)         buyer-signed ETH client
 *               locks ETH in AgentSwapHTLC contract (createLock)
 *               refunds ETH after timelock expiry   (refund)
 *
 * ETH CLAIM NOTE
 * ─────────────────────────────────────────────────────────────────────────────
 * After `settleSwap` reveals the preimage on Lightning, the preimage is
 * public on the Lightning network. The seller's ETH client (NOT managed by
 * this coordinator) must then call `AgentSwapHTLC.claim(lockId, preimage)` to
 * receive the locked ETH. The coordinator emits 'swap:settled' with the hex
 * preimage so the seller can act on it.
 *
 * SECURITY — TIMELOCK ORDERING (enforced in initiateSwap)
 * ─────────────────────────────────────────────────────────────────────────────
 *   ETH timelock MUST be SHORTER than BTC timelock.
 *
 *   If the seller hasn't settled BTC before the ETH timelock expires, the
 *   buyer can refund ETH before the BTC HTLC also times out. This prevents
 *   the seller from being in a state where they lose BTC funds without being
 *   able to claim ETH.
 *
 *   Defaults: ETH = 24 h, BTC = 48 h.  Enforced: ETH < BTC (strict).
 *
 * ERROR HANDLING — ETH LOCKED / BTC FAILED
 * ─────────────────────────────────────────────────────────────────────────────
 *   If ETH lock succeeds but BTC invoice creation fails, the ETH is stranded
 *   until the timelock expires (the smart contract does not allow early refund).
 *   The coordinator marks the swap REFUNDED, emits 'swap:refunded', and stores
 *   the lockId so the buyer can call htlcClient.refund(lockId) once expiry
 *   passes. A deferred refund is scheduled automatically.
 */

import { EventEmitter } from "events";
import * as dotenv from "dotenv";
dotenv.config();

import { SwapState } from "@agentswap/shared";
import type { SwapProposal } from "@agentswap/shared";
import type { LNDClient } from "@agentswap/lightning";
import { ArbitratorAgent } from "./arbitratorAgent.js";
import { SwapStore } from "./swapStore.js";
import type {
  CoordinatorSwapRecord,
  HTLCClient,
  PublicSwapRecord,
  SwapCoordinatorConfig,
} from "./types.js";
import type {
  CoordinatorEventMap,
  StateChangeEvent,
  BtcLockedEvent,
  BtcPaymentRequestEvent,
  DeliverableSubmittedEvent,
  SwapSettledEvent,
  SwapRefundedEvent,
  CoordinatorErrorEvent,
} from "./events.js";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ETH_TIMELOCK_HOURS = 24;
const DEFAULT_BTC_TIMELOCK_HOURS = 48;
const LOG_PREFIX = "[SwapCoordinator]";

// ── TypeScript declaration merging for typed EventEmitter ────────────────────

// Declaration merging: adds typed overloads for on/once/off/emit.
// Must be `export declare interface` because `SwapCoordinator` the class is exported.
export declare interface SwapCoordinator {
  on<K extends keyof CoordinatorEventMap>(
    event: K,
    listener: CoordinatorEventMap[K]
  ): this;
  once<K extends keyof CoordinatorEventMap>(
    event: K,
    listener: CoordinatorEventMap[K]
  ): this;
  off<K extends keyof CoordinatorEventMap>(
    event: K,
    listener: CoordinatorEventMap[K]
  ): this;
  emit<K extends keyof CoordinatorEventMap>(
    event: K,
    ...args: Parameters<CoordinatorEventMap[K]>
  ): boolean;
}

// ── SwapCoordinator ──────────────────────────────────────────────────────────

export class SwapCoordinator extends EventEmitter {
  private readonly lndClient: LNDClient;
  private readonly htlcClient: HTLCClient;
  private readonly sellerEthAddress: string;
  private readonly agentModel: string;
  private readonly store: SwapStore;
  private readonly arbitratorAgent: ArbitratorAgent;

  /**
   * @param lndClient       Seller's LND REST client.  Used to create, settle,
   *                        and cancel HODL invoices.
   * @param htlcClient      Buyer's ETH HTLC client (signed with buyer's private
   *                        key).  Used to lock and refund ETH.
   * @param anthropicApiKey Anthropic API key for the arbitrator agent.  If the
   *                        env var ANTHROPIC_API_KEY is already set it takes
   *                        precedence; the constructor param is a fallback for
   *                        programmatic use (e.g. tests).
   * @param config          Optional config overrides.
   */
  constructor(
    lndClient: LNDClient,
    htlcClient: HTLCClient,
    anthropicApiKey: string,
    config: SwapCoordinatorConfig = {}
  ) {
    super();

    this.lndClient = lndClient;
    this.htlcClient = htlcClient;
    this.store = new SwapStore();

    // Ensure the LLM singleton in llm.ts can find the key.
    if (!process.env.ANTHROPIC_API_KEY && anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    this.sellerEthAddress =
      config.sellerEthAddress ??
      process.env.ETH_SELLER_ADDRESS ??
      "";

    this.agentModel =
      config.agentModel ??
      process.env.AGENT_MODEL ??
      "claude-sonnet-4-6";

    this.arbitratorAgent = new ArbitratorAgent({
      anthropicApiKey,
      model: this.agentModel,
    });

    if (!this.sellerEthAddress) {
      this.log(null, "WARNING: sellerEthAddress is not configured. ETH locks will fail.");
    }
  }

  // ── initiateSwap ─────────────────────────────────────────────────────────────

  /**
   * Kick off a new atomic swap.
   *
   * Steps:
   *   1. Generate preimage + preimageHash (via LND client)
   *   2. Validate timelock ordering (throws if ETH >= BTC)
   *   3. Lock ETH in the AgentSwapHTLC contract (buyer → seller escrow)
   *   4. Create BTC HODL invoice on seller's LND node with the same hash
   *      → if this step fails, the ETH lock is stranded; a deferred refund is
   *        scheduled automatically (see _scheduleEthRefund)
   *   5. Transition state → LOCKED
   *   6. Emit 'state:change' and 'btc:payment_request'
   *   7. Start awaitBtcLock() in the background
   *   8. Return swapId
   *
   * @param proposal  Agreed swap terms.  The coordinator overwrites
   *                  proposal.preimageHash with its freshly generated value.
   * @returns The swap ID (same as proposal.id).
   */
  async initiateSwap(proposal: SwapProposal): Promise<string> {
    const swapId = proposal.id;
    const now = Date.now();

    // ── Step 1: Generate preimage ──────────────────────────────────────────
    const { preimage, preimageHash } = this.lndClient.generatePreimage();
    const preimageHashHex = preimageHash.toString("hex");
    const preimageHashEth = "0x" + preimageHashHex;

    // ── Step 2: Validate timelock ordering ─────────────────────────────────
    const ethHours = proposal.timelock_eth_hours || DEFAULT_ETH_TIMELOCK_HOURS;
    const btcHours = proposal.timelock_btc_hours || DEFAULT_BTC_TIMELOCK_HOURS;

    if (ethHours >= btcHours) {
      throw new Error(
        `Timelock ordering violation: ETH timelock (${ethHours}h) must be` +
        ` strictly shorter than BTC timelock (${btcHours}h).` +
        ` Default safe values are ETH=24h, BTC=48h.`
      );
    }

    // Enrich proposal with the coordinator-generated hash
    const enrichedProposal: SwapProposal = {
      ...proposal,
      preimageHash: preimageHashHex,
      timelock_eth_hours: ethHours,
      timelock_btc_hours: btcHours,
      updatedAt: new Date().toISOString(),
    };

    // Initialise the record before any async work so errors can reference it.
    const record: CoordinatorSwapRecord = {
      id: swapId,
      proposal: enrichedProposal,
      state: SwapState.NEGOTIATING,
      preimage,
      preimageHash: preimageHashHex,
      createdAt: now,
    };
    this.store.set(swapId, record);

    this.log(
      swapId,
      `Initiating swap. ETH=${ethHours}h BTC=${btcHours}h` +
      ` hash=${preimageHashHex.slice(0, 12)}…`
    );

    // ── Step 3: Lock ETH ───────────────────────────────────────────────────
    let ethLockId: string;
    try {
      const lockResult = await this.htlcClient.createLock({
        preimageHash: preimageHashEth,
        seller: this.sellerEthAddress,
        timelockHours: ethHours,
        amountWei: enrichedProposal.ethAmountWei,
      });

      ethLockId = lockResult.lockId;
      this.store.update(swapId, {
        ethLockId,
        ethReceipt: lockResult.receipt,
      });

      this.log(swapId, `ETH locked. lockId=${ethLockId} txId=${lockResult.receipt.txId}`);
    } catch (err) {
      const error = toError(err);
      this.log(swapId, `ETH lock FAILED: ${error.message}`);
      this.store.update(swapId, { state: SwapState.REFUNDED, refundedAt: Date.now() });
      this._emitError(swapId, error);
      throw error;
    }

    // ── Step 4: Create BTC HODL invoice ────────────────────────────────────
    try {
      const hodlResult = await this.lndClient.createHodlInvoice(
        preimageHash,
        Number(enrichedProposal.btcAmountSats),
        btcHours * 3600
      );

      const btcReceipt = {
        chain: "btc" as const,
        txId: hodlResult.rHash,
        lockTime: Math.floor(hodlResult.expiryAt.getTime() / 1000),
        amount: enrichedProposal.btcAmountSats.toString(),
        preimageHash: preimageHashHex,
        invoice: hodlResult.paymentRequest,
      };

      this.store.update(swapId, {
        btcRHash: hodlResult.rHash,
        btcPaymentRequest: hodlResult.paymentRequest,
        btcReceipt,
      });

      this.log(
        swapId,
        `BTC HODL invoice created. rHash=${hodlResult.rHash.slice(0, 12)}…` +
        ` expiresAt=${hodlResult.expiryAt.toISOString()}`
      );

      // ── Step 5 & 6: Transition to LOCKED ──────────────────────────────────
      this._transition(swapId, SwapState.LOCKED);

      // Emit payment request for the buyer's UI
      const prEvent: BtcPaymentRequestEvent = {
        swapId,
        paymentRequest: hodlResult.paymentRequest,
        expiryAt: hodlResult.expiryAt.toISOString(),
        timestamp: new Date().toISOString(),
      };
      this.emit("btc:payment_request", prEvent);

      // ── Step 7: Start watching for BTC payment ─────────────────────────
      this.awaitBtcLock(swapId).catch((watchErr) => {
        this._emitError(swapId, toError(watchErr));
      });
    } catch (err) {
      // ETH is locked but BTC invoice creation failed — schedule deferred refund.
      const error = toError(err);
      this.log(
        swapId,
        `BTC invoice creation FAILED after ETH lock. ` +
        `ETH lockId=${ethLockId} is stranded until ETH timelock (${ethHours}h) expires. ` +
        `A deferred refund has been scheduled. Error: ${error.message}`
      );
      this.store.update(swapId, { state: SwapState.REFUNDED, refundedAt: Date.now() });

      const refundedEvent: SwapRefundedEvent = {
        swapId,
        reason: `BTC invoice creation failed: ${error.message}. ETH refund pending timelock expiry.`,
        timestamp: new Date().toISOString(),
      };
      this.emit("swap:refunded", refundedEvent);

      // Schedule a refund attempt after the ETH timelock expires (+60s buffer).
      this._scheduleEthRefund(swapId, ethLockId, ethHours * 3600 * 1000 + 60_000);
      throw error;
    }

    return swapId;
  }

  // ── awaitBtcLock ─────────────────────────────────────────────────────────────

  /**
   * Wait for the buyer to pay the HODL invoice.
   *
   * Polls until the invoice transitions to ACCEPTED (BTC locked in escrow)
   * or CANCELED (buyer didn't pay / expired).
   *
   * This method is called automatically by initiateSwap() in the background.
   * You may also call it directly if you want to await the BTC confirmation
   * before proceeding in your own orchestration logic.
   */
  async awaitBtcLock(swapId: string): Promise<void> {
    const record = this.store.getOrThrow(swapId);

    if (!record.btcRHash) {
      throw new Error(`awaitBtcLock: swap ${swapId} has no btcRHash — was initiateSwap called?`);
    }

    this.log(swapId, `Waiting for buyer to pay HODL invoice rHash=${record.btcRHash.slice(0, 12)}…`);

    const result = await this.lndClient.waitForPayment(record.btcRHash);

    if (result === "ACCEPTED") {
      this.log(swapId, `BTC payment confirmed — funds locked in Lightning HTLC.`);
      // Confirm the LOCKED state (it was set in initiateSwap; this is the second confirmation)
      this._transition(swapId, SwapState.LOCKED);

      const event: BtcLockedEvent = {
        swapId,
        rHash: record.btcRHash,
        timestamp: new Date().toISOString(),
      };
      this.emit("btc:locked", event);
    } else {
      // CANCELED — invoice expired or buyer cancelled
      const reason = `BTC invoice was CANCELED (rHash=${record.btcRHash})`;
      this.log(swapId, reason);
      await this.refundSwap(swapId, reason);
    }
  }

  // ── submitDeliverable ────────────────────────────────────────────────────────

  /**
   * Seller submits their work product.
   *
   * Steps:
   *   1. Store the deliverable in the swap record.
   *   2. Transition state → EVALUATING.
   *   3. Emit 'deliverable:submitted'.
   *   4. Run arbitrator evaluation (LLM call).
   *   5. On APPROVED: automatically call settleSwap().
   *   6. On REJECTED: automatically call refundSwap().
   *
   * @param swapId      The swap to submit the deliverable for.
   * @param deliverable The work product — text, URL, or content hash.
   */
  async submitDeliverable(swapId: string, deliverable: string): Promise<void> {
    const record = this.store.getOrThrow(swapId);

    this._assertState(swapId, record, [SwapState.LOCKED], "submitDeliverable");

    // 1. Store deliverable
    this.store.update(swapId, { deliverable });
    this.log(swapId, `Deliverable submitted (${deliverable.length} chars)`);

    // 2. Transition to EVALUATING
    this._transition(swapId, SwapState.EVALUATING);

    // 3. Emit event
    const submittedEvent: DeliverableSubmittedEvent = {
      swapId,
      deliverablePreview: deliverable.slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    this.emit("deliverable:submitted", submittedEvent);

    // 4. Run arbitration via ArbitratorAgent (structured per-criterion evaluation)
    this.log(swapId, `Starting arbitrator evaluation (model=${this.agentModel})`);
    let evalResult;
    try {
      evalResult = await this.arbitratorAgent.evaluateDeliverable(
        swapId,
        record.proposal.taskDescription,
        deliverable
      );
    } catch (err) {
      const error = toError(err);
      this.log(swapId, `Arbitrator evaluation error: ${error.message}`);
      this._emitError(swapId, error);
      throw error;
    }

    this.store.update(swapId, {
      arbitratorReasoning: evalResult.reasoning,
      qualityScore: evalResult.score,
      criteriaScores: evalResult.criteria,
    });

    this.log(
      swapId,
      `Arbitrator verdict: ${evalResult.approved ? "APPROVED" : "REJECTED"}` +
      ` score=${evalResult.score}/100 — ${evalResult.reasoning}`
    );

    // 5 / 6. Execute decision — settleSwap() on approve, refundSwap() on reject
    await this.arbitratorAgent.executeDecision(evalResult, this);
  }

  // ── settleSwap ───────────────────────────────────────────────────────────────

  /**
   * Happy path settlement — called by the arbitrator on approval.
   *
   * Steps:
   *   1. Reveal the preimage on Lightning (settleInvoice).
   *      The seller's LND node broadcasts the preimage on the network.
   *   2. The preimage is now PUBLIC — the seller can use it to call
   *      AgentSwapHTLC.claim(lockId, preimage) on Ethereum to receive the ETH.
   *      (This must be done by the seller's own ETH client, not this coordinator.)
   *   3. Transition state → SETTLED.
   *   4. Emit 'swap:settled' with preimageHex and txIds.
   *
   * @param swapId  The swap to settle.
   */
  async settleSwap(swapId: string): Promise<void> {
    const record = this.store.getOrThrow(swapId);

    this._assertState(
      swapId,
      record,
      [SwapState.LOCKED, SwapState.EVALUATING, SwapState.APPROVED],
      "settleSwap"
    );

    if (!record.preimage) {
      throw new Error(`settleSwap: preimage not found for swap ${swapId}`);
    }

    // Transition through APPROVED if not already there
    if (record.state !== SwapState.APPROVED) {
      this._transition(swapId, SwapState.APPROVED);
    }

    // 1. Reveal preimage on Lightning — BTC settles at this moment
    this.log(swapId, `Settling BTC HODL invoice — revealing preimage on Lightning`);
    try {
      await this.lndClient.settleInvoice(record.preimage);
    } catch (err) {
      const error = toError(err);
      this.log(swapId, `BTC settle FAILED: ${error.message}`);
      this._emitError(swapId, error);
      throw error;
    }

    const preimageHex = record.preimage.toString("hex");
    this.log(
      swapId,
      `BTC HODL invoice settled. Preimage is now public on Lightning.` +
      ` Seller must call AgentSwapHTLC.claim(${record.ethLockId ?? "?"}, 0x${preimageHex}) to receive ETH.`
    );

    // 2 & 3. Transition to SETTLED
    const settledAt = Date.now();
    this.store.update(swapId, { settledAt });
    this._transition(swapId, SwapState.SETTLED);

    // 4. Emit settled event
    const event: SwapSettledEvent = {
      swapId,
      preimageHex,
      btcTxId: record.btcRHash,
      ethTxId: record.ethReceipt?.txId,
      timestamp: new Date().toISOString(),
    };
    this.emit("swap:settled", event);
  }

  // ── refundSwap ───────────────────────────────────────────────────────────────

  /**
   * Refund path — called by the arbitrator on rejection, or on timelock expiry.
   *
   * Steps:
   *   1. Cancel the BTC HODL invoice (buyer's in-flight sats return to them).
   *   2. Attempt to refund ETH via htlcClient.refund(lockId).
   *      This will REVERT if the ETH timelock has not expired yet. In that case
   *      the coordinator logs the failure and schedules a deferred retry.
   *   3. Transition state → REFUNDED.
   *   4. Emit 'swap:refunded'.
   *
   * @param swapId   The swap to refund.
   * @param reason   Human-readable explanation (shown in the dashboard).
   */
  async refundSwap(swapId: string, reason: string): Promise<void> {
    const record = this.store.getOrThrow(swapId);

    // Allow refund from any non-terminal state
    if (record.state === SwapState.SETTLED || record.state === SwapState.REFUNDED) {
      this.log(swapId, `refundSwap called on already-terminal state ${record.state} — skipping`);
      return;
    }

    this.log(swapId, `Refunding swap. Reason: ${reason}`);

    let ethRefundTxHash: string | undefined;

    // 1. Cancel BTC HODL invoice
    if (record.btcRHash) {
      try {
        await this.lndClient.cancelInvoice(record.btcRHash);
        this.log(swapId, `BTC HODL invoice cancelled (rHash=${record.btcRHash.slice(0, 12)}…)`);
      } catch (err) {
        // Non-fatal: invoice may already be cancelled or expired
        this.log(swapId, `BTC cancel warning: ${toError(err).message}`);
      }
    }

    // 2. Attempt ETH refund
    if (record.ethLockId) {
      try {
        ethRefundTxHash = await this.htlcClient.refund(record.ethLockId);
        this.log(swapId, `ETH refund tx submitted: ${ethRefundTxHash}`);
      } catch (err) {
        const msg = toError(err).message;
        // The contract reverts with LockNotExpired before timelock passes.
        // Schedule a deferred retry so the buyer eventually gets their ETH back.
        const ethTimelock = record.proposal.timelock_eth_hours * 3600 * 1000;
        const elapsed = Date.now() - record.createdAt;
        const remaining = Math.max(0, ethTimelock - elapsed) + 60_000; // +60s buffer
        this.log(
          swapId,
          `ETH refund not yet available (${msg}). ` +
          `Scheduling retry in ${Math.round(remaining / 1000)}s.`
        );
        this._scheduleEthRefund(swapId, record.ethLockId, remaining);
      }
    }

    // 3. Transition to REFUNDED
    const refundedAt = Date.now();
    this.store.update(swapId, { refundedAt });
    this._transition(swapId, SwapState.REFUNDED);

    // 4. Emit refunded event
    const event: SwapRefundedEvent = {
      swapId,
      reason,
      ethRefundTxHash,
      timestamp: new Date().toISOString(),
    };
    this.emit("swap:refunded", event);
  }

  // ── Read ──────────────────────────────────────────────────────────────────────

  /**
   * Returns the public (preimage-stripped) record for a swap.
   * Throws if not found.
   */
  getSwap(swapId: string): PublicSwapRecord {
    const record = this.store.getOrThrow(swapId);
    return this._toPublic(record);
  }

  /**
   * Returns public records for all tracked swaps.
   */
  getAllSwaps(): PublicSwapRecord[] {
    return this.store.getAll().map(this._toPublic);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Transition the swap to a new state, update the store, and emit
   * a 'state:change' event. All transitions are logged.
   */
  private _transition(swapId: string, newState: SwapState): void {
    const record = this.store.update(swapId, { state: newState });
    this.log(swapId, `State → ${newState}`);

    const event: StateChangeEvent = {
      swapId,
      newState,
      record: this._toPublic(record),
      timestamp: new Date().toISOString(),
    };
    this.emit("state:change", event);
  }

  /**
   * Guard that throws if the record is not in one of the expected states.
   */
  private _assertState(
    swapId: string,
    record: CoordinatorSwapRecord,
    allowed: SwapState[],
    caller: string
  ): void {
    if (!allowed.includes(record.state)) {
      throw new Error(
        `${caller}: swap ${swapId} is in state ${record.state},` +
        ` expected one of [${allowed.join(", ")}]`
      );
    }
  }

  /**
   * Emit an 'error' event with a structured payload.
   */
  private _emitError(swapId: string, error: Error): void {
    const record = this.store.get(swapId);
    const event: CoordinatorErrorEvent = {
      swapId,
      message: error.message,
      state: record?.state,
      timestamp: new Date().toISOString(),
    };
    this.emit("error", event);
  }

  /**
   * Strip the secret preimage from an internal record before returning it
   * to external callers.
   */
  private _toPublic(record: CoordinatorSwapRecord): PublicSwapRecord {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { preimage: _secret, ...pub } = record;
    return pub;
  }

  /**
   * Schedule a deferred ETH refund attempt.
   *
   * Called when the ETH refund fails because the timelock has not expired.
   * Uses a single setTimeout — sufficient for a hackathon. Production code
   * would persist the scheduled refund across restarts.
   *
   * @param swapId     The swap ID (for logging).
   * @param ethLockId  The bytes32 lockId in the AgentSwapHTLC contract.
   * @param delayMs    Milliseconds to wait before retrying.
   */
  private _scheduleEthRefund(
    swapId: string,
    ethLockId: string,
    delayMs: number
  ): void {
    this.log(swapId, `ETH deferred refund scheduled in ${Math.round(delayMs / 1000)}s for lockId=${ethLockId}`);
    setTimeout(async () => {
      this.log(swapId, `Attempting deferred ETH refund for lockId=${ethLockId}`);
      try {
        const txHash = await this.htlcClient.refund(ethLockId);
        this.log(swapId, `Deferred ETH refund succeeded: ${txHash}`);
        this.store.update(swapId, { refundedAt: Date.now() });

        // Emit an updated refunded event with the tx hash
        const event: SwapRefundedEvent = {
          swapId,
          reason: "Deferred ETH refund completed after timelock expiry",
          ethRefundTxHash: txHash,
          timestamp: new Date().toISOString(),
        };
        this.emit("swap:refunded", event);
      } catch (err) {
        // If the deferred attempt also fails, emit an error and give up.
        const error = toError(err);
        this.log(swapId, `Deferred ETH refund FAILED: ${error.message}. Manual intervention required.`);
        this._emitError(swapId, error);
      }
    }, delayMs);
  }

  /**
   * Structured log line: [ISO timestamp] [SwapCoordinator] [swapId:8chars…] message
   */
  private log(swapId: string | null, message: string): void {
    const ts = new Date().toISOString();
    const id = swapId ? ` [${swapId.slice(0, 8)}…]` : "";
    console.log(`${ts} ${LOG_PREFIX}${id} ${message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
