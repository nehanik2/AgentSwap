/**
 * Swap Orchestrator
 *
 * Drives the full AgentSwap lifecycle from negotiation → settlement:
 *
 *   NEGOTIATING  — buyer + seller exchange proposals
 *        ↓
 *   LOCKED       — ETH HTLC locked by seller; Lightning invoice paid by buyer
 *        ↓
 *   EVALUATING   — seller submits deliverable; arbitrator reviews
 *        ↓
 *   APPROVED     — arbitrator releases preimage
 *        ↓
 *   SETTLED      — seller claims BTC; buyer claims ETH  (or REFUNDED on timeout)
 *
 * All state transitions emit events so the dashboard can stream them via SSE.
 */

import { EventEmitter } from "events";
import * as dotenv from "dotenv";
dotenv.config();

import { LndClient } from "@agentswap/lightning";
import {
  lockBtcHTLC,
  payBtcHTLC,
  settleBtcHTLC,
  waitForHTLCAccepted,
} from "@agentswap/lightning";
import { EthHTLCClient, uuidToBytes32 } from "@agentswap/ethereum";
import { SwapState } from "@agentswap/shared";
import type {
  SwapProposal,
  SwapRecord,
  AgentMessage,
  Preimage,
} from "@agentswap/shared";

import { createProposal, evaluateCounterOffer, buildBuyerMessage } from "./buyer.js";
import { evaluateBuyerProposal, produceDeliverable, buildSellerMessage } from "./seller.js";
import { evaluateDeliverable, buildArbitratorMessage } from "./arbitrator.js";

// ── Typed event map for TypeScript strict mode ────────────────────────────────

export interface OrchestratorEvents {
  message: (msg: AgentMessage) => void;
  stateChange: (swapId: string, state: SwapState) => void;
  error: (swapId: string, err: Error) => void;
  complete: (record: SwapRecord) => void;
}

export class SwapOrchestrator extends EventEmitter {
  private readonly buyerLnd: LndClient;
  private readonly sellerLnd: LndClient;
  private readonly ethClient: EthHTLCClient;

  constructor() {
    super();

    this.buyerLnd = new LndClient({
      restUrl: process.env.BUYER_LND_REST_URL ?? "https://localhost:8080",
      tlsCertPath: process.env.BUYER_LND_TLS_CERT_PATH ?? "",
    });

    this.sellerLnd = new LndClient({
      restUrl: process.env.SELLER_LND_REST_URL ?? "https://localhost:8081",
      tlsCertPath: process.env.SELLER_LND_TLS_CERT_PATH ?? "",
    });

    this.ethClient = new EthHTLCClient({
      rpcUrl: process.env.ETH_RPC_URL ?? "http://localhost:8545",
      privateKey: process.env.ETH_SELLER_PRIVATE_KEY ?? "",
      contractAddress: process.env.ETH_HTLC_CONTRACT_ADDRESS ?? "",
    });
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  async runSwap(taskDescription: string): Promise<SwapRecord> {
    // 1. Buyer creates initial proposal
    const { proposal: initialProposal, preimage } = await createProposal(taskDescription);
    const record: SwapRecord = {
      proposal: initialProposal,
      state: SwapState.NEGOTIATING,
      messages: [],
    };

    this.emit("stateChange", initialProposal.id, SwapState.NEGOTIATING);

    const addMsg = (msg: AgentMessage) => {
      record.messages.push(msg);
      this.emit("message", msg);
    };

    addMsg(buildBuyerMessage(
      initialProposal,
      `I'd like to hire you for: "${taskDescription}". Offering ${initialProposal.btcAmountSats} sats (BTC) + ${initialProposal.ethAmountWei} wei (ETH).`,
    ));

    // 2. Negotiation loop (max 5 rounds)
    let currentProposal = initialProposal;
    let agreed = false;

    for (let round = 1; round <= 5 && !agreed; round++) {
      const sellerResult = await evaluateBuyerProposal({ proposal: currentProposal, round });
      addMsg(buildSellerMessage(currentProposal, sellerResult.message));

      if (sellerResult.decision === "accept") {
        agreed = true;
        break;
      }
      if (sellerResult.decision === "reject") {
        throw new Error("Seller rejected the proposal — no deal reached.");
      }

      // Seller counter-offer → buyer evaluates
      const merged: SwapProposal = {
        ...currentProposal,
        ...(sellerResult.counterProposal ?? {}),
        updatedAt: new Date().toISOString(),
      };
      const buyerResult = await evaluateCounterOffer({
        currentProposal: merged,
        sellerMessage: record.messages[record.messages.length - 1]!,
        round,
      });

      if (buyerResult.decision === "accept") {
        currentProposal = merged;
        agreed = true;
        addMsg(buildBuyerMessage(currentProposal, "Deal! I accept your terms. Let's lock the funds."));
        break;
      }
      if (buyerResult.decision === "reject") {
        throw new Error("Buyer rejected after seller counter — negotiation failed.");
      }

      currentProposal = buyerResult.counterProposal ?? merged;
      addMsg(buildBuyerMessage(
        currentProposal,
        `Counter-offer: ${currentProposal.btcAmountSats} sats / ${currentProposal.ethAmountWei} wei. What do you say?`,
      ));
    }

    if (!agreed) throw new Error("Negotiation exceeded max rounds without agreement.");
    record.proposal = currentProposal;

    // 3. Lock funds
    await this._lockFunds(record, preimage, addMsg);

    // 4. Seller produces deliverable
    record.state = SwapState.EVALUATING;
    this.emit("stateChange", currentProposal.id, SwapState.EVALUATING);

    const deliverable = await produceDeliverable(currentProposal);
    addMsg(buildSellerMessage(
      currentProposal,
      `Deliverable ready:\n\n${deliverable.slice(0, 200)}${deliverable.length > 200 ? "…" : ""}`,
    ));

    // 5. Arbitrate
    const verdict = await evaluateDeliverable({
      proposal: currentProposal,
      deliverable,
      preimage,
    });
    const arbitratorMsg = buildArbitratorMessage(verdict);
    addMsg(arbitratorMsg);
    record.verdict = verdict;

    if (verdict.approved) {
      record.state = SwapState.APPROVED;
      this.emit("stateChange", currentProposal.id, SwapState.APPROVED);
      await this._settle(record, preimage, addMsg);
    } else {
      record.state = SwapState.REFUNDED;
      this.emit("stateChange", currentProposal.id, SwapState.REFUNDED);
      addMsg(buildArbitratorMessage({ ...verdict, reasoning: "Refund initiated: " + verdict.reasoning }));
    }

    record.settledAt = Date.now();
    this.emit("complete", record);
    return record;
  }

  // ── Private: Lock ───────────────────────────────────────────────────────────

  private async _lockFunds(
    record: SwapRecord,
    preimage: Preimage,
    addMsg: (m: AgentMessage) => void,
  ): Promise<void> {
    const proposal = record.proposal;

    // 3a. Seller locks ETH HTLC first (they commit capital to show good faith)
    const buyerEthAddress = process.env.ETH_BUYER_ADDRESS ?? "";
    const ethReceipt = await this.ethClient.lock({
      swapId: uuidToBytes32(proposal.id),
      recipient: buyerEthAddress,
      preimage,
      amountWei: proposal.ethAmountWei,
      timelockHours: proposal.timelock_eth_hours,
    });
    record.ethReceipt = ethReceipt;

    addMsg(buildSellerMessage(proposal, `ETH HTLC locked. TxHash: ${ethReceipt.txId}. Waiting for your Lightning payment...`));

    // 3b. Seller creates Lightning hold invoice
    const { receipt: btcReceipt, invoice } = await lockBtcHTLC({
      sellerLnd: this.sellerLnd,
      preimageHash: proposal.preimageHash,
      // LND REST API accepts integers up to Number.MAX_SAFE_INTEGER (9007199254740991 sats >> max supply)
      amountSats: Number(proposal.btcAmountSats), // safe: max BTC supply is 21e14 sats < 2^53
      timelockHours: proposal.timelock_btc_hours,
    });
    record.btcReceipt = { ...btcReceipt, invoice };

    addMsg(buildSellerMessage(proposal, `Lightning invoice created. Please pay: ${invoice.slice(0, 40)}...`));

    // 3c. Buyer pays the invoice
    await payBtcHTLC({
      buyerLnd: this.buyerLnd,
      invoice,
    });

    addMsg(buildBuyerMessage(proposal, "Lightning payment sent! Waiting for HTLC confirmation..."));

    // 3d. Wait for the invoice to move to ACCEPTED state (funds in escrow)
    const htlcState = await waitForHTLCAccepted({
      sellerLnd: this.sellerLnd,
      preimageHash: proposal.preimageHash,
    });

    if (htlcState !== "ACCEPTED") {
      throw new Error(`Lightning HTLC reached unexpected state: ${htlcState}`);
    }

    record.state = SwapState.LOCKED;
    this.emit("stateChange", proposal.id, SwapState.LOCKED);
    addMsg(buildBuyerMessage(proposal, "Both HTLCs confirmed locked! 🔒 Funds are in escrow. Awaiting deliverable..."));
  }

  // ── Private: Settle ─────────────────────────────────────────────────────────

  private async _settle(
    record: SwapRecord,
    preimage: Preimage,
    addMsg: (m: AgentMessage) => void,
  ): Promise<void> {
    const proposal = record.proposal;

    // Seller settles Lightning invoice by revealing the preimage
    await settleBtcHTLC({ sellerLnd: this.sellerLnd, preimage });
    addMsg(buildSellerMessage(proposal, "Lightning HTLC settled — BTC claimed! ⚡"));

    // Buyer (or anyone) can now claim ETH since preimage is public on-chain
    // In production the buyer agent does this; for the demo the orchestrator does it
    const buyerEthClient = new EthHTLCClient({
      rpcUrl: process.env.ETH_RPC_URL ?? "http://localhost:8545",
      privateKey: process.env.ETH_BUYER_PRIVATE_KEY ?? "",
      contractAddress: process.env.ETH_HTLC_CONTRACT_ADDRESS ?? "",
    });

    const claimTx = await buyerEthClient.claim(uuidToBytes32(proposal.id), preimage);
    addMsg(buildBuyerMessage(proposal, `ETH HTLC claimed! TxHash: ${claimTx} 🎉`));

    record.state = SwapState.SETTLED;
    this.emit("stateChange", proposal.id, SwapState.SETTLED);
  }
}
