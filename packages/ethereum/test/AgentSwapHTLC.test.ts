/**
 * AgentSwapHTLC — Hardhat / Mocha / Chai test suite.
 *
 * Covers:
 *   1. Happy path  — buyer creates lock → seller claims with correct preimage
 *   2. Refund path — buyer creates lock → time-travel past expiry → buyer refunds
 *   3. Double-claim prevention — second claim on an already-claimed lock reverts
 *   4. Wrong preimage rejection — claim with bad preimage reverts
 *
 * Additional edge-case tests:
 *   5. Claim after expiry reverts
 *   6. Refund before expiry reverts
 *   7. Non-seller cannot claim
 *   8. Non-buyer cannot refund
 *   9. Double-refund prevention
 *  10. Zero-value lock reverts
 *  11. Zero seller address reverts
 *  12. getLock returns full struct data
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { AgentSwapHTLC } from "../typechain-types";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a random 32-byte hex preimage (0x-prefixed). */
function randomPreimage(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Compute sha256(abi.encodePacked(bytes32 preimage)) — matches Solidity.
 * ethers.solidityPacked(["bytes32"], [value]) == abi.encodePacked(bytes32(value))
 */
function sha256Preimage(preimageHex: string): string {
  const packed = ethers.solidityPacked(["bytes32"], [preimageHex]);
  return ethers.sha256(packed);
}

/** Default timelock for most tests: 1 hour. */
const TIMELOCK_HOURS = 1n;
/** Lock amount: 0.01 ETH in wei. */
const LOCK_AMOUNT = ethers.parseEther("0.01");

// ── Fixture ───────────────────────────────────────────────────────────────────

/**
 * Deploys a fresh AgentSwapHTLC contract and returns signers + contract.
 * loadFixture snapshots state so each test starts from a clean deploy.
 */
async function deployFixture(): Promise<{
  htlc: AgentSwapHTLC;
  buyer: HardhatEthersSigner;
  seller: HardhatEthersSigner;
  stranger: HardhatEthersSigner;
}> {
  const [buyer, seller, stranger] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("AgentSwapHTLC");
  const htlc = (await Factory.deploy()) as AgentSwapHTLC;
  await htlc.waitForDeployment();
  return { htlc, buyer, seller, stranger };
}

/**
 * Helper: buyer creates a lock and returns the lockId from the emitted event.
 */
async function createLock(
  htlc: AgentSwapHTLC,
  buyer: HardhatEthersSigner,
  seller: HardhatEthersSigner,
  preimageHash: string,
  timelockHours: bigint = TIMELOCK_HOURS,
  amount: bigint = LOCK_AMOUNT
): Promise<string> {
  const tx = await htlc
    .connect(buyer)
    .createLock(preimageHash, seller.address, timelockHours, { value: amount });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt");

  const log = receipt.logs.find(
    (l) => l.topics[0] === htlc.interface.getEvent("LockCreated").topicHash
  );
  if (!log) throw new Error("LockCreated event not found");

  const parsed = htlc.interface.parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed) throw new Error("Failed to parse LockCreated log");

  return parsed.args.lockId as string;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("AgentSwapHTLC", function () {
  // ── 1. Happy path claim ────────────────────────────────────────────────────

  describe("Happy path — claim with correct preimage", function () {
    it("transfers ETH to seller and marks lock as claimed", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);

      const claimTx = await htlc.connect(seller).claim(lockId, preimage);
      const claimReceipt = await claimTx.wait(1);
      if (!claimReceipt) throw new Error("No claim receipt");

      const gasUsed = claimReceipt.gasUsed * claimReceipt.gasPrice;
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

      // Seller balance should increase by lock amount minus gas.
      expect(sellerBalanceAfter).to.equal(
        sellerBalanceBefore + LOCK_AMOUNT - gasUsed
      );

      const lock = await htlc.getLock(lockId);
      expect(lock.claimed).to.be.true;
      expect(lock.refunded).to.be.false;
    });

    it("emits Claimed event with preimage and timestamp", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      await expect(htlc.connect(seller).claim(lockId, preimage))
        .to.emit(htlc, "Claimed")
        .withArgs(lockId, preimage, await time.latest().then((t) => t + 1));
    });

    it("emits LockCreated with correct fields", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const tx = htlc
        .connect(buyer)
        .createLock(preimageHash, seller.address, TIMELOCK_HOURS, { value: LOCK_AMOUNT });

      await expect(tx)
        .to.emit(htlc, "LockCreated")
        .withArgs(
          // lockId — any bytes32
          (v: string) => typeof v === "string" && v.length === 66,
          buyer.address,
          seller.address,
          LOCK_AMOUNT,
          preimageHash,
          // expiry — any future timestamp
          (v: bigint) => v > BigInt(Math.floor(Date.now() / 1000))
        );
    });

    it("getLock returns correct struct after claim", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await htlc.connect(seller).claim(lockId, preimage);

      const lock = await htlc.getLock(lockId);
      expect(lock.buyer).to.equal(buyer.address);
      expect(lock.seller).to.equal(seller.address);
      expect(lock.amount).to.equal(LOCK_AMOUNT);
      expect(lock.preimageHash).to.equal(preimageHash);
      expect(lock.claimed).to.be.true;
      expect(lock.refunded).to.be.false;
    });
  });

  // ── 2. Refund after expiry ─────────────────────────────────────────────────

  describe("Refund path — refund after expiry", function () {
    it("returns ETH to buyer after timelock expires", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      // Fast-forward past the 1-hour timelock.
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      const refundTx = await htlc.connect(buyer).refund(lockId);
      const refundReceipt = await refundTx.wait(1);
      if (!refundReceipt) throw new Error("No refund receipt");

      const gasUsed = refundReceipt.gasUsed * refundReceipt.gasPrice;
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      expect(buyerBalanceAfter).to.equal(buyerBalanceBefore + LOCK_AMOUNT - gasUsed);

      const lock = await htlc.getLock(lockId);
      expect(lock.refunded).to.be.true;
      expect(lock.claimed).to.be.false;
    });

    it("emits Refunded event", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      await expect(htlc.connect(buyer).refund(lockId))
        .to.emit(htlc, "Refunded")
        .withArgs(lockId, (v: bigint) => v > 0n);
    });
  });

  // ── 3. Double-claim prevention ─────────────────────────────────────────────

  describe("Double-claim prevention", function () {
    it("reverts on a second claim attempt", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await htlc.connect(seller).claim(lockId, preimage);

      await expect(htlc.connect(seller).claim(lockId, preimage))
        .to.be.revertedWithCustomError(htlc, "AlreadyClaimed")
        .withArgs(lockId);
    });

    it("reverts when buyer tries to refund an already-claimed lock", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await htlc.connect(seller).claim(lockId, preimage);

      // Even after expiry a claimed lock cannot be refunded.
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      await expect(htlc.connect(buyer).refund(lockId))
        .to.be.revertedWithCustomError(htlc, "AlreadyClaimed")
        .withArgs(lockId);
    });
  });

  // ── 4. Wrong preimage rejection ────────────────────────────────────────────

  describe("Wrong preimage rejection", function () {
    it("reverts when preimage does not hash to preimageHash", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const correctPreimage = randomPreimage();
      const wrongPreimage = randomPreimage(); // different random bytes

      const preimageHash = sha256Preimage(correctPreimage);
      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      await expect(htlc.connect(seller).claim(lockId, wrongPreimage))
        .to.be.revertedWithCustomError(htlc, "BadPreimage")
        .withArgs(lockId);
    });

    it("reverts on all-zeros preimage when hash doesn't match", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const correctPreimage = randomPreimage();
      const preimageHash = sha256Preimage(correctPreimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      const zeroPreimage = ethers.ZeroHash; // 0x000...000

      await expect(htlc.connect(seller).claim(lockId, zeroPreimage))
        .to.be.revertedWithCustomError(htlc, "BadPreimage")
        .withArgs(lockId);
    });
  });

  // ── 5. Claim after expiry ──────────────────────────────────────────────────

  describe("Time-boundary guards", function () {
    it("reverts claim after the timelock expires", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      await expect(htlc.connect(seller).claim(lockId, preimage))
        .to.be.revertedWithCustomError(htlc, "LockExpired")
        .withArgs(lockId);
    });

    it("reverts refund before the timelock expires", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      await expect(htlc.connect(buyer).refund(lockId))
        .to.be.revertedWithCustomError(htlc, "LockNotExpired")
        .withArgs(lockId);
    });
  });

  // ── 6 & 7. Access control ─────────────────────────────────────────────────

  describe("Access control", function () {
    it("reverts when a non-seller tries to claim", async function () {
      const { htlc, buyer, seller, stranger } = await loadFixture(deployFixture);
      const preimage = randomPreimage();
      const preimageHash = sha256Preimage(preimage);

      const lockId = await createLock(htlc, buyer, seller, preimageHash);

      await expect(htlc.connect(stranger).claim(lockId, preimage))
        .to.be.revertedWithCustomError(htlc, "NotSeller")
        .withArgs(lockId, stranger.address);
    });

    it("reverts when a non-buyer tries to refund", async function () {
      const { htlc, buyer, seller, stranger } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      await expect(htlc.connect(stranger).refund(lockId))
        .to.be.revertedWithCustomError(htlc, "NotBuyer")
        .withArgs(lockId, stranger.address);
    });
  });

  // ── 8. Double-refund prevention ───────────────────────────────────────────

  describe("Double-refund prevention", function () {
    it("reverts on a second refund attempt", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      const lockId = await createLock(htlc, buyer, seller, preimageHash);
      await time.increase(TIMELOCK_HOURS * 3600n + 1n);

      await htlc.connect(buyer).refund(lockId);

      await expect(htlc.connect(buyer).refund(lockId))
        .to.be.revertedWithCustomError(htlc, "AlreadyRefunded")
        .withArgs(lockId);
    });
  });

  // ── 9. Input validation ───────────────────────────────────────────────────

  describe("Input validation", function () {
    it("reverts createLock with zero ETH value", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      await expect(
        htlc.connect(buyer).createLock(preimageHash, seller.address, TIMELOCK_HOURS, {
          value: 0n,
        })
      ).to.be.revertedWithCustomError(htlc, "ZeroValue");
    });

    it("reverts createLock with zero seller address", async function () {
      const { htlc, buyer } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      await expect(
        htlc
          .connect(buyer)
          .createLock(preimageHash, ethers.ZeroAddress, TIMELOCK_HOURS, {
            value: LOCK_AMOUNT,
          })
      ).to.be.revertedWithCustomError(htlc, "ZeroSeller");
    });

    it("reverts createLock with zero timelockHours", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());

      await expect(
        htlc.connect(buyer).createLock(preimageHash, seller.address, 0n, {
          value: LOCK_AMOUNT,
        })
      ).to.be.revertedWithCustomError(htlc, "ZeroTimelockHours");
    });

    it("reverts claim on a non-existent lockId", async function () {
      const { htlc, seller } = await loadFixture(deployFixture);
      const fakeLockId = ethers.ZeroHash;
      const preimage = randomPreimage();

      await expect(htlc.connect(seller).claim(fakeLockId, preimage))
        .to.be.revertedWithCustomError(htlc, "LockNotFound")
        .withArgs(fakeLockId);
    });

    it("reverts refund on a non-existent lockId", async function () {
      const { htlc, buyer } = await loadFixture(deployFixture);
      const fakeLockId = ethers.ZeroHash;

      await expect(htlc.connect(buyer).refund(fakeLockId))
        .to.be.revertedWithCustomError(htlc, "LockNotFound")
        .withArgs(fakeLockId);
    });
  });

  // ── 10. getLock view ──────────────────────────────────────────────────────

  describe("getLock view", function () {
    it("returns zero-value struct for unknown lockId", async function () {
      const { htlc } = await loadFixture(deployFixture);
      const lock = await htlc.getLock(ethers.ZeroHash);
      expect(lock.amount).to.equal(0n);
      expect(lock.claimed).to.be.false;
      expect(lock.refunded).to.be.false;
    });

    it("reflects the correct expiry (block.timestamp + timelockHours * 3600)", async function () {
      const { htlc, buyer, seller } = await loadFixture(deployFixture);
      const preimageHash = sha256Preimage(randomPreimage());
      const timelockHours = 3n;

      const txTimestamp = (await time.latest()) + 1;
      const lockId = await createLock(htlc, buyer, seller, preimageHash, timelockHours);

      const lock = await htlc.getLock(lockId);
      const expectedExpiry = BigInt(txTimestamp) + timelockHours * 3600n;

      // Allow ±2 seconds for block timestamp variance.
      expect(lock.expiry).to.be.gte(expectedExpiry - 2n);
      expect(lock.expiry).to.be.lte(expectedExpiry + 2n);
    });
  });
});
