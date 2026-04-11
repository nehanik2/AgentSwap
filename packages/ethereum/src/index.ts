// Original HashedTimelockETH client (keccak256-based)
export { EthHTLCClient, keccakPreimage, uuidToBytes32, HTLC_ABI } from "./client.js";
export type { EthHTLCClientConfig } from "./client.js";

// AgentSwapHTLC client (SHA-256-based, matches Bitcoin Lightning)
export {
  AgentSwapHTLCClient,
  sha256Preimage,
  generatePreimage,
  AGENTSWAP_HTLC_ABI,
} from "./htlcClient.js";
export type {
  AgentSwapHTLCClientConfig,
  CreateLockParams,
  CreateLockResult,
  LockData,
  HTLCEventHandlers,
} from "./htlcClient.js";
