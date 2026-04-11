// ── SwapCoordinator (new) ────────────────────────────────────────────────────
export { SwapCoordinator } from "./swapCoordinator.js";
export { SwapStore } from "./swapStore.js";
export type {
  HTLCClient,
  SwapCoordinatorConfig,
  CoordinatorSwapRecord,
  PublicSwapRecord,
} from "./types.js";
export type {
  CoordinatorEventMap,
  StateChangeEvent,
  BtcLockedEvent,
  BtcPaymentRequestEvent,
  DeliverableSubmittedEvent,
  SwapSettledEvent,
  SwapRefundedEvent,
  CoordinatorErrorEvent,
} from "./events.js";

// ── SwapOrchestrator (existing) ──────────────────────────────────────────────
export { SwapOrchestrator } from "./orchestrator.js";
export type { OrchestratorEvents } from "./orchestrator.js";

// ── Agent helpers ────────────────────────────────────────────────────────────
export { createProposal, evaluateCounterOffer, buildBuyerMessage } from "./buyer.js";
export { evaluateBuyerProposal, produceDeliverable, buildSellerMessage } from "./seller.js";
export { evaluateDeliverable, buildArbitratorMessage } from "./arbitrator.js";
export { chat, chatJSON } from "./llm.js";
