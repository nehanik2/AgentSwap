/**
 * POST /api/swap
 * Body: { taskDescription: string }
 *
 * Starts a new AgentSwap run in the background and returns the swapId.
 * Progress is streamed via GET /api/swap/stream?swapId=...
 */

import { NextRequest, NextResponse } from "next/server";
import { swapStore } from "../../../lib/store.js";
import type { AgentMessage, SwapState, SwapRecord } from "@agentswap/shared";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as { taskDescription?: string };

  if (!body.taskDescription?.trim()) {
    return NextResponse.json({ error: "taskDescription is required" }, { status: 400 });
  }

  // Dynamic import keeps Node-only packages (LND, ethers) out of the client bundle.
  const { SwapOrchestrator } = await import("@agentswap/agents");
  const orchestrator = new SwapOrchestrator();

  // swapId is populated from the first agent message/stateChange event.
  let swapId: string | null = null;

  orchestrator.on("message", (msg: AgentMessage) => {
    if (!swapId) {
      swapId = msg.swapId;
      swapStore.init(swapId);
    }
    // Rebind to a const so TS knows it's non-null inside this closure
    const id = swapId;
    swapStore.addMessage(id, msg);
    swapStore.notifySubscribers(id);
  });

  orchestrator.on("stateChange", (id: string, state: SwapState) => {
    swapId = id;
    if (!swapStore.has(id)) swapStore.init(id);
    swapStore.setState(id, state);
    swapStore.notifySubscribers(id);
  });

  orchestrator.on("complete", (record: SwapRecord) => {
    const id = record.proposal.id;
    swapStore.setComplete(id, record);
    swapStore.notifySubscribers(id);
  });

  orchestrator.on("error", (id: string, err: Error) => {
    swapStore.setError(id, err.message);
    swapStore.notifySubscribers(id);
  });

  // Run in background — do NOT await
  orchestrator.runSwap(body.taskDescription.trim()).catch((err: unknown) => {
    if (swapId !== null) swapStore.setError(swapId, String(err));
  });

  // Wait briefly for the first event to populate swapId (max 5s)
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (swapId !== null) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });

  return NextResponse.json({ swapId: swapId ?? "pending" });
}
