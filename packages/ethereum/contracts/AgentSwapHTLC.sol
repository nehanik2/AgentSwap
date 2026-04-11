// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentSwapHTLC
 * @notice Production-quality Hashed Time-Locked Contract for the AgentSwap cross-chain
 *         atomic swap system.
 *
 * @dev Design overview:
 *      1. createLock()  — buyer locks ETH against a SHA-256 preimage hash + timelock.
 *      2. claim()       — seller reveals the preimage (released by the AI arbitrator on
 *                         deliverable approval) to receive the ETH.
 *      3. refund()      — buyer reclaims ETH if the timelock expires without a claim.
 *
 *      Hash function: SHA-256 (Solidity built-in precompile at address 0x02).
 *      This deliberately matches the hash function used by Bitcoin Lightning (BOLT spec),
 *      so the same preimage unlocks both legs of the cross-chain swap. The AI arbitrator
 *      holds the preimage and releases it only after approving the seller's deliverable.
 *
 *      Reentrancy: OpenZeppelin ReentrancyGuard is applied to claim() and refund().
 *      State is also updated before any value transfer (Checks-Effects-Interactions).
 *
 *      Lock ID: keccak256(buyer ‖ seller ‖ preimageHash ‖ block.timestamp) — unique per tx.
 *
 * @custom:security-contact security@agentswap.dev
 */
contract AgentSwapHTLC is ReentrancyGuard {
    // ── Data structures ──────────────────────────────────────────────────────

    /**
     * @dev Full state for a single locked HTLC position.
     *      Stored by lockId in `_locks`.
     */
    struct Lock {
        /// @notice Address that created and funded the lock (can call refund).
        address buyer;
        /// @notice Address that can claim ETH by revealing the preimage.
        address payable seller;
        /// @notice Amount of ETH locked in wei.
        uint256 amount;
        /// @notice SHA-256(preimage) — the hashlock commitment.
        bytes32 preimageHash;
        /// @notice Unix timestamp after which the buyer may call refund().
        uint256 expiry;
        /// @notice True once the seller has successfully claimed.
        bool claimed;
        /// @notice True once the buyer has successfully refunded.
        bool refunded;
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    /// @dev lockId → Lock struct. Private; exposed via getLock().
    mapping(bytes32 => Lock) private _locks;

    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a new HTLC lock is created.
     * @param lockId       Unique identifier for the lock.
     * @param buyer        Address that funded the lock.
     * @param seller       Address authorised to claim.
     * @param amount       ETH locked in wei.
     * @param preimageHash SHA-256 hash of the secret preimage.
     * @param expiry       Unix timestamp of lock expiry.
     */
    event LockCreated(
        bytes32 indexed lockId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        bytes32 preimageHash,
        uint256 expiry
    );

    /**
     * @notice Emitted when the seller successfully claims the locked ETH.
     * @param lockId    Identifier of the claimed lock.
     * @param preimage  The revealed 32-byte preimage secret.
     * @param claimedAt Block timestamp of the claim.
     */
    event Claimed(bytes32 indexed lockId, bytes32 preimage, uint256 claimedAt);

    /**
     * @notice Emitted when the buyer successfully refunds an expired lock.
     * @param lockId     Identifier of the refunded lock.
     * @param refundedAt Block timestamp of the refund.
     */
    event Refunded(bytes32 indexed lockId, uint256 refundedAt);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroValue();
    error ZeroSeller();
    error ZeroTimelockHours();
    error LockAlreadyExists(bytes32 lockId);
    error LockNotFound(bytes32 lockId);
    error AlreadyClaimed(bytes32 lockId);
    error AlreadyRefunded(bytes32 lockId);
    error LockExpired(bytes32 lockId);
    error LockNotExpired(bytes32 lockId);
    error NotSeller(bytes32 lockId, address caller);
    error NotBuyer(bytes32 lockId, address caller);
    error BadPreimage(bytes32 lockId);
    error TransferFailed(address recipient, uint256 amount);

    // ── External functions ───────────────────────────────────────────────────

    /**
     * @notice Create a new HTLC, locking the sent ETH against a SHA-256 preimage hash.
     *
     * @dev The caller is recorded as the `buyer` and must send ETH with the call.
     *      The lockId is deterministic from the inputs plus `block.timestamp`; callers
     *      within the same block with identical parameters will receive distinct lockIds
     *      only if block.timestamp differs — callers should treat lockId as opaque.
     *
     * @param preimageHash  SHA-256(preimage) as a bytes32. Must match what the seller
     *                      will reveal in claim(). For Lightning compatibility, compute
     *                      this as sha256(preimage_bytes) off-chain.
     * @param seller        Payable address authorised to call claim(). Must be non-zero.
     * @param timelockHours Number of hours from now until the lock expires and the buyer
     *                      may call refund(). Must be at least 1.
     * @return lockId       The unique identifier for this lock. Emit in LockCreated.
     */
    function createLock(
        bytes32 preimageHash,
        address payable seller,
        uint256 timelockHours
    ) external payable returns (bytes32 lockId) {
        if (msg.value == 0) revert ZeroValue();
        if (seller == address(0)) revert ZeroSeller();
        if (timelockHours == 0) revert ZeroTimelockHours();

        // Compute a unique lockId that binds all parties and the hash commitment.
        lockId = keccak256(
            abi.encodePacked(msg.sender, seller, preimageHash, block.timestamp)
        );

        // Protect against an astronomically unlikely same-block collision.
        if (_locks[lockId].amount != 0) revert LockAlreadyExists(lockId);

        uint256 expiry = block.timestamp + timelockHours * 1 hours;

        _locks[lockId] = Lock({
            buyer: msg.sender,
            seller: seller,
            amount: msg.value,
            preimageHash: preimageHash,
            expiry: expiry,
            claimed: false,
            refunded: false
        });

        emit LockCreated(lockId, msg.sender, seller, msg.value, preimageHash, expiry);
    }

    /**
     * @notice Seller claims the locked ETH by revealing the SHA-256 preimage.
     *
     * @dev Protected by OpenZeppelin ReentrancyGuard and the Checks-Effects-Interactions
     *      pattern: state is written before the ETH transfer occurs.
     *      Only callable by the designated seller and only before expiry.
     *
     * @param lockId   The lock identifier returned by createLock().
     * @param preimage The 32-byte secret such that sha256(abi.encodePacked(preimage))
     *                 equals Lock.preimageHash.
     */
    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage lock_ = _locks[lockId];

        if (lock_.amount == 0)    revert LockNotFound(lockId);
        if (lock_.claimed)        revert AlreadyClaimed(lockId);
        if (lock_.refunded)       revert AlreadyRefunded(lockId);
        if (block.timestamp >= lock_.expiry) revert LockExpired(lockId);
        if (msg.sender != lock_.seller)      revert NotSeller(lockId, msg.sender);

        // Verify SHA-256 hash — matches Bitcoin Lightning BOLT spec.
        if (sha256(abi.encodePacked(preimage)) != lock_.preimageHash)
            revert BadPreimage(lockId);

        // --- Effects ---
        lock_.claimed = true;
        uint256 amount = lock_.amount;
        address payable seller = lock_.seller;

        emit Claimed(lockId, preimage, block.timestamp);

        // --- Interactions ---
        (bool ok, ) = seller.call{value: amount}("");
        if (!ok) revert TransferFailed(seller, amount);
    }

    /**
     * @notice Buyer reclaims locked ETH after the timelock has expired.
     *
     * @dev Protected by OpenZeppelin ReentrancyGuard and CEI pattern.
     *      Only callable by the original buyer and only after expiry.
     *
     * @param lockId The lock identifier returned by createLock().
     */
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage lock_ = _locks[lockId];

        if (lock_.amount == 0)   revert LockNotFound(lockId);
        if (lock_.claimed)       revert AlreadyClaimed(lockId);
        if (lock_.refunded)      revert AlreadyRefunded(lockId);
        if (block.timestamp < lock_.expiry) revert LockNotExpired(lockId);
        if (msg.sender != lock_.buyer)      revert NotBuyer(lockId, msg.sender);

        // --- Effects ---
        lock_.refunded = true;
        uint256 amount = lock_.amount;
        address payable buyer = payable(lock_.buyer);

        emit Refunded(lockId, block.timestamp);

        // --- Interactions ---
        (bool ok, ) = buyer.call{value: amount}("");
        if (!ok) revert TransferFailed(buyer, amount);
    }

    /**
     * @notice Read the full Lock struct for a given lockId.
     *
     * @dev Returns a zero-value struct (amount == 0, all bools false, zero addresses)
     *      if the lockId does not exist. Callers should check lock.amount > 0.
     *
     * @param lockId The lock identifier.
     * @return       The Lock struct; a zero-value struct if the lock does not exist.
     */
    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }
}
