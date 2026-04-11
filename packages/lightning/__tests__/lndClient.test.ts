/**
 * Integration tests for LNDClient.
 *
 * These tests require a live LND node. They are automatically skipped when
 * LND is not reachable, so they are safe to run in CI without Docker.
 *
 * To run against a local Docker stack:
 *   pnpm docker:up          # start bitcoind + LND nodes + ganache
 *   bash scripts/fund-wallets.sh
 *   pnpm --filter @agentswap/lightning test
 *
 * Environment variables (all optional — defaults match docker-compose.yml):
 *   LND_BUYER_URL        Base URL for the buyer LND node  (default: https://localhost:8080)
 *   LND_BUYER_MACAROON   base64 admin macaroon, or ""     (default: "" — no-macaroons)
 *   LND_SELLER_URL       Base URL for the seller LND node (default: https://localhost:8081)
 *   LND_SELLER_MACAROON  base64 admin macaroon, or ""     (default: "")
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LNDClient } from "../src/lndClient.js";

// ── Config ───────────────────────────────────────────────────────────────────

const BUYER_URL = process.env.LND_BUYER_URL ?? "https://localhost:8080";
const BUYER_MACAROON = process.env.LND_BUYER_MACAROON ?? "";
const SELLER_URL = process.env.LND_SELLER_URL ?? "https://localhost:8081";
const SELLER_MACAROON = process.env.LND_SELLER_MACAROON ?? "";

const AMOUNT_SATS = 1_000;
const EXPIRY_SECONDS = 3_600; // 1 hour

// ── Availability probe ───────────────────────────────────────────────────────

/**
 * Returns true if the LND node at the given URL responds to /v1/getinfo.
 * Used to skip tests when Docker is not running.
 */
async function isLndReachable(url: string, macaroon: string): Promise<boolean> {
  try {
    const client = new LNDClient(url, macaroon);
    // lookupInvoice with a dummy hash will fail with 404/500, but a connection
    // error means LND is down. We use getChannelBalance as a lightweight probe.
    await client.getChannelBalance();
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Network-level errors indicate LND is not running
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("connect")
    ) {
      return false;
    }
    // HTTP errors (401, 500) mean LND is up but something else is wrong — still reachable
    return true;
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("LNDClient", () => {
  let buyerClient: LNDClient;
  let sellerClient: LNDClient;
  let skipReason: string | null = null;

  before(async () => {
    buyerClient = new LNDClient(BUYER_URL, BUYER_MACAROON);
    sellerClient = new LNDClient(SELLER_URL, SELLER_MACAROON);

    const [buyerUp, sellerUp] = await Promise.all([
      isLndReachable(BUYER_URL, BUYER_MACAROON),
      isLndReachable(SELLER_URL, SELLER_MACAROON),
    ]);

    if (!buyerUp) skipReason = `Buyer LND not reachable at ${BUYER_URL}`;
    else if (!sellerUp) skipReason = `Seller LND not reachable at ${SELLER_URL}`;
  });

  // ── Unit-level: preimage generation (no network) ─────────────────────────

  describe("generatePreimage", () => {
    it("returns 32-byte preimage and 32-byte SHA-256 hash", () => {
      const { preimage, preimageHash } = buyerClient.generatePreimage();

      assert.equal(preimage.length, 32, "preimage should be 32 bytes");
      assert.equal(preimageHash.length, 32, "preimageHash should be 32 bytes");
    });

    it("hash is the SHA-256 of the preimage", () => {
      const { preimage, preimageHash } = buyerClient.generatePreimage();
      const expected = crypto.createHash("sha256").update(preimage).digest();
      assert.deepEqual(preimageHash, expected);
    });

    it("each call returns a unique preimage", () => {
      const a = buyerClient.generatePreimage();
      const b = buyerClient.generatePreimage();
      assert.notDeepEqual(a.preimage, b.preimage);
      assert.notDeepEqual(a.preimageHash, b.preimageHash);
    });
  });

  // ── Integration: create → pay → settle (happy path) ─────────────────────

  describe("happy path: create HODL invoice → pay → settle", () => {
    it("creates invoice, buyer pays it, seller settles with preimage", async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      // 1. Seller generates the preimage (in real swap the buyer generates it)
      const { preimage, preimageHash } = sellerClient.generatePreimage();

      // 2. Seller creates HODL invoice locked to the hash
      const invoice = await sellerClient.createHodlInvoice(
        preimageHash,
        AMOUNT_SATS,
        EXPIRY_SECONDS
      );

      assert.ok(invoice.paymentRequest.startsWith("ln"), "must be a valid BOLT-11 string");
      assert.equal(invoice.rHash.length, 64, "rHash must be 64 hex chars");
      assert.ok(invoice.expiryAt > new Date(), "expiryAt must be in the future");

      // The rHash returned by createHodlInvoice should equal SHA-256(preimage)
      const expectedHash = crypto
        .createHash("sha256")
        .update(preimage)
        .digest("hex");
      assert.equal(invoice.rHash, expectedHash);

      // 3. Buyer pays the invoice
      const payment = await buyerClient.payInvoice(invoice.paymentRequest);
      assert.equal(payment.status, "SUCCEEDED", "payment must succeed");

      // 4. Verify the HTLC is in ACCEPTED state (funds locked, not yet settled)
      const inv = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(inv.state, "ACCEPTED", "invoice must be ACCEPTED after payment");

      // 5. waitForPayment should return immediately since state is already ACCEPTED
      const waitResult = await sellerClient.waitForPayment(invoice.rHash);
      assert.equal(waitResult, "ACCEPTED");

      // 6. Seller settles by revealing the preimage
      await sellerClient.settleInvoice(preimage);

      // 7. Verify final state is SETTLED
      const settled = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(settled.state, "SETTLED", "invoice must be SETTLED after settle call");
    });
  });

  // ── Integration: create → pay → cancel (refund path) ────────────────────

  describe("refund path: create HODL invoice → pay → cancel", async () => {
    it("creates invoice, buyer pays it, seller cancels — buyer gets refund", async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { preimageHash } = buyerClient.generatePreimage();

      // 1. Seller creates HODL invoice
      const invoice = await sellerClient.createHodlInvoice(
        preimageHash,
        AMOUNT_SATS,
        EXPIRY_SECONDS
      );

      // 2. Buyer pays
      const payment = await buyerClient.payInvoice(invoice.paymentRequest);
      assert.equal(payment.status, "SUCCEEDED");

      // 3. Verify ACCEPTED
      const accepted = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(accepted.state, "ACCEPTED");

      // 4. Seller cancels (e.g. arbitrator rejected)
      await sellerClient.cancelInvoice(invoice.rHash);

      // 5. Verify CANCELED
      const canceled = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(canceled.state, "CANCELED");

      // 6. waitForPayment should return CANCELED if polled now
      const waitResult = await sellerClient.waitForPayment(invoice.rHash);
      assert.equal(waitResult, "CANCELED");
    });
  });

  // ── Integration: cancel unpaid invoice ──────────────────────────────────

  describe("cancel path: create invoice → cancel before payment", () => {
    it("cancels an OPEN invoice without payment", async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { preimageHash } = sellerClient.generatePreimage();

      const invoice = await sellerClient.createHodlInvoice(
        preimageHash,
        AMOUNT_SATS,
        EXPIRY_SECONDS
      );

      const before = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(before.state, "OPEN");

      await sellerClient.cancelInvoice(invoice.rHash);

      const after = await sellerClient.lookupInvoice(invoice.rHash);
      assert.equal(after.state, "CANCELED");
    });
  });

  // ── Integration: channel balance ─────────────────────────────────────────

  describe("getChannelBalance", () => {
    it("returns non-negative local and remote balances", async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const balance = await buyerClient.getChannelBalance();

      assert.ok(typeof balance.local === "number", "local must be a number");
      assert.ok(typeof balance.remote === "number", "remote must be a number");
      assert.ok(balance.local >= 0, "local balance must be non-negative");
      assert.ok(balance.remote >= 0, "remote balance must be non-negative");
    });
  });
});
