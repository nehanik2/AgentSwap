/**
 * packages/agents/src/preimageVault.ts
 *
 * PreimageVault — AES-256-GCM encrypted in-memory store for HTLC preimages.
 *
 * SECURITY DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 *   The raw preimage Buffer is NEVER stored in plaintext. Each entry is
 *   encrypted with AES-256-GCM using a unique 12-byte IV and a 16-byte auth tag
 *   so that even if the in-memory store is dumped, the preimages remain opaque.
 *
 *   Vault key derivation:
 *     - Accepts a 32-byte Buffer or a 64-char hex string.
 *     - Falls back to a random 32-byte key when none is provided (suitable
 *       for single-process demos; restart clears all entries anyway).
 *
 *   Process isolation:
 *     - The vault lives in the same process as the coordinator.
 *     - No IPC, disk persistence, or network exposure.
 *     - Entries survive only as long as the Node.js process runs.
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   const vault = new PreimageVault();         // random ephemeral key
 *   vault.store("swap-abc", preimageBuffer);
 *   const preimage = vault.retrieve("swap-abc");  // Buffer | undefined
 *   vault.delete("swap-abc");                  // clean up after settlement
 */

import crypto from "crypto";

// ── Internal types ────────────────────────────────────────────────────────────

interface VaultEntry {
  /** 12-byte GCM nonce, unique per entry. */
  iv: Buffer;
  /** 16-byte GCM authentication tag. */
  authTag: Buffer;
  /** Encrypted ciphertext (same length as the plaintext preimage). */
  ciphertext: Buffer;
}

// ── PreimageVault ────────────────────────────────────────────────────────────

export class PreimageVault {
  private readonly key: Buffer;
  private readonly entries = new Map<string, VaultEntry>();

  /**
   * @param key  Optional 32-byte encryption key (Buffer or 64-char hex string).
   *             If omitted, a cryptographically random key is generated.
   *             The key is never accessible after construction (no getter).
   */
  constructor(key?: Buffer | string) {
    if (key === undefined) {
      this.key = crypto.randomBytes(32);
    } else if (typeof key === "string") {
      if (key.length !== 64) {
        throw new Error("PreimageVault: hex key must be exactly 64 characters (32 bytes)");
      }
      this.key = Buffer.from(key, "hex");
    } else {
      if (key.length !== 32) {
        throw new Error("PreimageVault: Buffer key must be exactly 32 bytes");
      }
      this.key = Buffer.from(key); // copy — caller cannot mutate after construction
    }
  }

  // ── store ─────────────────────────────────────────────────────────────────

  /**
   * Encrypt and store a preimage for the given swapId.
   *
   * Overwrites any existing entry for the same swapId.
   *
   * @param swapId   Primary key — should be the UUID from the swap proposal.
   * @param preimage Raw 32-byte HTLC preimage.
   */
  store(swapId: string, preimage: Buffer): void {
    const iv = crypto.randomBytes(12); // 96-bit nonce — recommended for GCM
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(preimage),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    this.entries.set(swapId, { iv, authTag, ciphertext });
  }

  // ── retrieve ──────────────────────────────────────────────────────────────

  /**
   * Decrypt and return the preimage for the given swapId.
   *
   * Returns `undefined` if the entry does not exist.
   * Throws if the auth tag verification fails (data was tampered with).
   *
   * @param swapId  The swap identifier used when `store()` was called.
   */
  retrieve(swapId: string): Buffer | undefined {
    const entry = this.entries.get(swapId);
    if (!entry) return undefined;

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, entry.iv);
    decipher.setAuthTag(entry.authTag);

    const plaintext = Buffer.concat([
      decipher.update(entry.ciphertext),
      decipher.final(), // throws if auth tag check fails
    ]);

    return plaintext;
  }

  // ── delete ────────────────────────────────────────────────────────────────

  /**
   * Remove the encrypted entry for the given swapId.
   *
   * Should be called after the preimage has been used (settleInvoice / claim)
   * so the encrypted bytes are not held in memory longer than necessary.
   *
   * @returns `true` if an entry was deleted, `false` if it didn't exist.
   */
  delete(swapId: string): boolean {
    return this.entries.delete(swapId);
  }

  // ── has ───────────────────────────────────────────────────────────────────

  /**
   * Check whether the vault holds an entry for the given swapId
   * without decrypting it.
   */
  has(swapId: string): boolean {
    return this.entries.has(swapId);
  }

  // ── size ──────────────────────────────────────────────────────────────────

  /** Number of entries currently in the vault. */
  get size(): number {
    return this.entries.size;
  }
}
