/**
 * AgentSwapHTLC TypeScript client.
 *
 * Thin, strongly-typed ethers v6 wrapper around the AgentSwapHTLC contract.
 * All amounts are in wei (bigint). No floating-point arithmetic.
 *
 * Typical usage:
 *   const client = new AgentSwapHTLCClient({ rpcUrl, privateKey, contractAddress });
 *   const { lockId } = await client.createLock({ preimageHash, seller, timelockHours, amountWei });
 *   // ... later, after arbitrator reveals preimage:
 *   await client.claim(lockId, preimage);
 */

import { ethers } from "ethers";
import type { HTLCReceipt, Preimage, PreimageHash } from "@agentswap/shared";

// ── ABI ───────────────────────────────────────────────────────────────────────
// Inlined so the client can be used without a Hardhat compile step at runtime.

export const AGENTSWAP_HTLC_ABI = [
  // Functions
  "function createLock(bytes32 preimageHash, address payable seller, uint256 timelockHours) payable external returns (bytes32 lockId)",
  "function claim(bytes32 lockId, bytes32 preimage) external",
  "function refund(bytes32 lockId) external",
  "function getLock(bytes32 lockId) external view returns (tuple(address buyer, address seller, uint256 amount, bytes32 preimageHash, uint256 expiry, bool claimed, bool refunded) lock)",

  // Events
  "event LockCreated(bytes32 indexed lockId, address indexed buyer, address indexed seller, uint256 amount, bytes32 preimageHash, uint256 expiry)",
  "event Claimed(bytes32 indexed lockId, bytes32 preimage, uint256 claimedAt)",
  "event Refunded(bytes32 indexed lockId, uint256 refundedAt)",

  // Custom errors (for decoding reverts)
  "error ZeroValue()",
  "error ZeroSeller()",
  "error ZeroTimelockHours()",
  "error LockAlreadyExists(bytes32 lockId)",
  "error LockNotFound(bytes32 lockId)",
  "error AlreadyClaimed(bytes32 lockId)",
  "error AlreadyRefunded(bytes32 lockId)",
  "error LockExpired(bytes32 lockId)",
  "error LockNotExpired(bytes32 lockId)",
  "error NotSeller(bytes32 lockId, address caller)",
  "error NotBuyer(bytes32 lockId, address caller)",
  "error BadPreimage(bytes32 lockId)",
  "error TransferFailed(address recipient, uint256 amount)",
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Decoded Lock struct returned by getLock(). */
export interface LockData {
  buyer: string;
  seller: string;
  amount: bigint;
  preimageHash: string;
  expiry: bigint;
  claimed: boolean;
  refunded: boolean;
}

/** Parameters for createLock(). */
export interface CreateLockParams {
  /** SHA-256(preimage) — 0x-prefixed 32-byte hex. Use sha256Preimage() helper. */
  preimageHash: PreimageHash;
  /** Ethereum address of the seller (who can call claim). */
  seller: string;
  /** Number of hours until the lock expires. */
  timelockHours: number;
  /** Amount of ETH to lock, in wei. */
  amountWei: bigint;
}

/** Result returned from createLock(). */
export interface CreateLockResult {
  /** The bytes32 lock identifier, emitted by the LockCreated event. */
  lockId: string;
  /** Full HTLCReceipt for persistence in SwapRecord. */
  receipt: HTLCReceipt;
}

/** Handlers passed to watchEvents(). All handlers are optional. */
export interface HTLCEventHandlers {
  onLockCreated?: (event: {
    lockId: string;
    buyer: string;
    seller: string;
    amount: bigint;
    preimageHash: string;
    expiry: bigint;
  }) => void;
  onClaimed?: (event: {
    lockId: string;
    preimage: string;
    claimedAt: bigint;
  }) => void;
  onRefunded?: (event: {
    lockId: string;
    refundedAt: bigint;
  }) => void;
}

/** Configuration for AgentSwapHTLCClient. */
export interface AgentSwapHTLCClientConfig {
  /** JSON-RPC endpoint URL (e.g. "http://localhost:8545"). */
  rpcUrl: string;
  /** 0x-prefixed private key of the signing account. */
  privateKey: string;
  /** Deployed AgentSwapHTLC contract address. */
  contractAddress: string;
}

// ── Preimage helpers ──────────────────────────────────────────────────────────

/**
 * Compute sha256(abi.encodePacked(bytes32 preimage)) — matches the Solidity contract.
 *
 * @param preimageHex 0x-prefixed 32-byte hex preimage.
 * @returns 0x-prefixed 32-byte hex SHA-256 hash.
 */
export function sha256Preimage(preimageHex: Preimage): PreimageHash {
  const normalised = preimageHex.startsWith("0x") ? preimageHex : "0x" + preimageHex;
  const padded = ethers.zeroPadValue(normalised, 32);
  // solidityPacked(["bytes32"], [value]) == abi.encodePacked(bytes32(value))
  const packed = ethers.solidityPacked(["bytes32"], [padded]);
  return ethers.sha256(packed);
}

/**
 * Generate a cryptographically random 32-byte preimage.
 * @returns 0x-prefixed 32-byte hex string.
 */
export function generatePreimage(): Preimage {
  return ethers.hexlify(ethers.randomBytes(32));
}

// ── Client class ──────────────────────────────────────────────────────────────

export class AgentSwapHTLCClient {
  public readonly provider: ethers.JsonRpcProvider;
  public readonly signer: ethers.Wallet;
  public readonly contract: ethers.Contract;
  public readonly contractAddress: string;

  constructor(config: AgentSwapHTLCClientConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
    this.contractAddress = config.contractAddress;
    this.contract = new ethers.Contract(
      config.contractAddress,
      AGENTSWAP_HTLC_ABI,
      this.signer
    );
  }

  // ── createLock ─────────────────────────────────────────────────────────────

  /**
   * Lock ETH in the HTLC contract.
   *
   * The buyer calls this to commit their ETH. The seller will be able to claim
   * once the AI arbitrator approves the deliverable and releases the preimage.
   *
   * @returns lockId (bytes32) and a full HTLCReceipt for persistence.
   */
  async createLock(params: CreateLockParams): Promise<CreateLockResult> {
    const tx: ethers.TransactionResponse = await this.contract.createLock(
      params.preimageHash,
      params.seller,
      BigInt(params.timelockHours),
      { value: params.amountWei }
    );

    const receipt = await tx.wait(1);
    if (!receipt) throw new Error("AgentSwapHTLC: createLock transaction failed");

    // Parse lockId from the LockCreated event.
    const iface = this.contract.interface;
    const lockCreatedFragment = iface.getEvent("LockCreated");
    if (!lockCreatedFragment) throw new Error("AgentSwapHTLC: LockCreated event not in ABI");
    const lockCreatedTopic = lockCreatedFragment.topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === lockCreatedTopic);
    if (!log) throw new Error("AgentSwapHTLC: LockCreated event not found in receipt");

    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) throw new Error("AgentSwapHTLC: failed to parse LockCreated log");

    const lockId = parsed.args.lockId as string;
    const expiry = parsed.args.expiry as bigint;

    const htlcReceipt: HTLCReceipt = {
      chain: "eth",
      txId: receipt.hash,
      lockTime: Number(expiry),
      amount: params.amountWei.toString(),
      preimageHash: params.preimageHash,
      contractAddress: this.contractAddress,
    };

    return { lockId, receipt: htlcReceipt };
  }

  // ── claim ──────────────────────────────────────────────────────────────────

  /**
   * Claim the locked ETH by revealing the SHA-256 preimage.
   *
   * Called by the seller after the AI arbitrator releases the preimage. The
   * preimage is verified on-chain: sha256(abi.encodePacked(preimage)) must equal
   * the preimageHash stored at createLock time.
   *
   * @param lockId   bytes32 lock identifier returned by createLock().
   * @param preimage 0x-prefixed 32-byte hex preimage secret.
   * @returns Transaction hash of the claim transaction.
   */
  async claim(lockId: string, preimage: Preimage): Promise<string> {
    const normalised = preimage.startsWith("0x") ? preimage : "0x" + preimage;
    const padded = ethers.zeroPadValue(normalised, 32);

    const tx: ethers.TransactionResponse = await this.contract.claim(lockId, padded);
    const receipt = await tx.wait(1);
    if (!receipt) throw new Error("AgentSwapHTLC: claim transaction failed");
    return receipt.hash;
  }

  // ── refund ─────────────────────────────────────────────────────────────────

  /**
   * Reclaim locked ETH after the timelock expires.
   *
   * Only the original buyer (msg.sender at createLock time) may call this, and
   * only after lock.expiry has passed.
   *
   * @param lockId bytes32 lock identifier returned by createLock().
   * @returns Transaction hash of the refund transaction.
   */
  async refund(lockId: string): Promise<string> {
    const tx: ethers.TransactionResponse = await this.contract.refund(lockId);
    const receipt = await tx.wait(1);
    if (!receipt) throw new Error("AgentSwapHTLC: refund transaction failed");
    return receipt.hash;
  }

  // ── getLock ────────────────────────────────────────────────────────────────

  /**
   * Read the full Lock struct for a given lockId.
   *
   * Returns a zero-value struct (amount === 0n, bools false, zero addresses) when
   * the lockId does not exist — callers should check lock.amount > 0n.
   *
   * @param lockId bytes32 lock identifier.
   */
  async getLock(lockId: string): Promise<LockData> {
    const raw = await this.contract.getLock(lockId);
    return {
      buyer: raw.buyer as string,
      seller: raw.seller as string,
      amount: raw.amount as bigint,
      preimageHash: raw.preimageHash as string,
      expiry: raw.expiry as bigint,
      claimed: raw.claimed as boolean,
      refunded: raw.refunded as boolean,
    };
  }

  // ── watchEvents ────────────────────────────────────────────────────────────

  /**
   * Subscribe to contract events. All three event types (LockCreated, Claimed,
   * Refunded) are optional — provide only the handlers you need.
   *
   * @param handlers Object of optional event handler callbacks.
   * @returns A cleanup function. Call it to remove all listeners and avoid leaks.
   *
   * @example
   * const stop = client.watchEvents({
   *   onLockCreated: ({ lockId, amount }) => console.log("locked", lockId, amount),
   *   onClaimed:     ({ lockId, preimage }) => console.log("claimed", lockId),
   * });
   * // Later:
   * stop();
   */
  watchEvents(handlers: HTLCEventHandlers): () => void {
    // ── LockCreated ──────────────────────────────────────────────────────────
    const lockCreatedHandler = handlers.onLockCreated
      ? (
          lockId: string,
          buyer: string,
          seller: string,
          amount: bigint,
          preimageHash: string,
          expiry: bigint
        ) => {
          handlers.onLockCreated!({ lockId, buyer, seller, amount, preimageHash, expiry });
        }
      : null;

    if (lockCreatedHandler) {
      this.contract.on("LockCreated", lockCreatedHandler);
    }

    // ── Claimed ──────────────────────────────────────────────────────────────
    const claimedHandler = handlers.onClaimed
      ? (lockId: string, preimage: string, claimedAt: bigint) => {
          handlers.onClaimed!({ lockId, preimage, claimedAt });
        }
      : null;

    if (claimedHandler) {
      this.contract.on("Claimed", claimedHandler);
    }

    // ── Refunded ─────────────────────────────────────────────────────────────
    const refundedHandler = handlers.onRefunded
      ? (lockId: string, refundedAt: bigint) => {
          handlers.onRefunded!({ lockId, refundedAt });
        }
      : null;

    if (refundedHandler) {
      this.contract.on("Refunded", refundedHandler);
    }

    // Return a cleanup function that removes all registered listeners.
    return () => {
      if (lockCreatedHandler) this.contract.off("LockCreated", lockCreatedHandler);
      if (claimedHandler)     this.contract.off("Claimed", claimedHandler);
      if (refundedHandler)    this.contract.off("Refunded", refundedHandler);
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /** Current ETH balance of any address, in wei. */
  async getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  /** Current block timestamp (Unix seconds). */
  async blockTimestamp(): Promise<number> {
    const block = await this.provider.getBlock("latest");
    if (!block) throw new Error("Could not fetch latest block");
    return block.timestamp;
  }
}
