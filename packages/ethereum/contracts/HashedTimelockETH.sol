// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HashedTimelockETH
 * @notice Minimal Hashed Timelock Contract for native ETH.
 *
 * Flow:
 *   1. lock()   — sender locks ETH + commits to a preimage hash + expiry.
 *   2. claim()  — recipient provides preimage → funds released.
 *   3. refund() — after expiry, sender can reclaim funds.
 *
 * Design decisions:
 * - We use keccak256 (not SHA-256) as the hashlock because it is cheaper
 *   on EVM. The agents generate the preimage, compute keccak256 off-chain,
 *   and supply that as the lock hash. The Lightning side uses SHA-256 via
 *   the hodl invoice; the two chains use DIFFERENT hash functions on purpose
 *   because the cross-chain atomicity is enforced by the AI arbitrator, not
 *   a shared hash (this is the "AI-mediated" novelty of AgentSwap).
 *
 * - No ERC-20 support to keep the contract minimal. Add a separate
 *   HashedTimelockERC20 if needed.
 */
contract HashedTimelockETH {

    // ── Events ───────────────────────────────────────────────────────────────

    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 hashlock,
        uint256 expiry
    );

    event Claimed(bytes32 indexed swapId, bytes32 preimage);
    event Refunded(bytes32 indexed swapId);

    // ── State ────────────────────────────────────────────────────────────────

    struct Swap {
        address payable sender;
        address payable recipient;
        uint256 amount;
        bytes32 hashlock;   // keccak256(preimage)
        uint256 expiry;     // Unix timestamp
        bool claimed;
        bool refunded;
        bytes32 preimage;   // stored after claim for auditability
    }

    mapping(bytes32 => Swap) public swaps;

    // ── Lock ─────────────────────────────────────────────────────────────────

    /**
     * @notice Lock ETH in escrow.
     * @param swapId    Unique identifier (matches SwapProposal.id encoded as bytes32).
     * @param recipient Who can claim with the preimage.
     * @param hashlock  keccak256(preimage).
     * @param expiry    Unix timestamp after which the sender can refund.
     */
    function lock(
        bytes32 swapId,
        address payable recipient,
        bytes32 hashlock,
        uint256 expiry
    ) external payable {
        require(msg.value > 0, "HTLC: zero value");
        require(expiry > block.timestamp, "HTLC: expiry in past");
        require(swaps[swapId].amount == 0, "HTLC: swap exists");
        require(recipient != address(0), "HTLC: zero recipient");

        swaps[swapId] = Swap({
            sender: payable(msg.sender),
            recipient: recipient,
            amount: msg.value,
            hashlock: hashlock,
            expiry: expiry,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        emit Locked(swapId, msg.sender, recipient, msg.value, hashlock, expiry);
    }

    // ── Claim ─────────────────────────────────────────────────────────────────

    /**
     * @notice Recipient claims ETH by revealing the preimage.
     */
    function claim(bytes32 swapId, bytes32 preimage) external {
        Swap storage s = swaps[swapId];
        require(s.amount > 0,                          "HTLC: no swap");
        require(!s.claimed,                            "HTLC: already claimed");
        require(!s.refunded,                           "HTLC: already refunded");
        require(block.timestamp < s.expiry,            "HTLC: expired");
        require(keccak256(abi.encode(preimage)) == s.hashlock, "HTLC: bad preimage");
        require(msg.sender == s.recipient,             "HTLC: not recipient");

        s.claimed = true;
        s.preimage = preimage;

        emit Claimed(swapId, preimage);

        // CEI pattern: state updated before transfer to prevent re-entrancy
        s.recipient.transfer(s.amount);
    }

    // ── Refund ───────────────────────────────────────────────────────────────

    /**
     * @notice Sender reclaims ETH after expiry.
     */
    function refund(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        require(s.amount > 0,           "HTLC: no swap");
        require(!s.claimed,             "HTLC: already claimed");
        require(!s.refunded,            "HTLC: already refunded");
        require(block.timestamp >= s.expiry, "HTLC: not expired");
        require(msg.sender == s.sender, "HTLC: not sender");

        s.refunded = true;

        emit Refunded(swapId);

        s.sender.transfer(s.amount);
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return swaps[swapId];
    }
}
