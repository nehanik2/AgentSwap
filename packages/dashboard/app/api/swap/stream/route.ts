/**
 * GET /api/swap/stream?swapId=<id>
 *
 * Server-Sent Events endpoint. The browser connects here and receives:
 *   - "message"     events with AgentMessage JSON
 *   - "stateChange" events with the new SwapState
 *   - "complete"    event with the final SwapRecord
 *   - "error"       event with error string
 *
 * We use SSE (not WebSockets) because Next.js App Router supports streaming
 * responses natively and SSE is simpler for one-directional push.
 */

import { NextRequest } from "next/server";
import { swapStore } from "../../../../lib/store.js";

export const runtime = "nodejs"; // required for ReadableStream + setTimeout

export async function GET(req: NextRequest): Promise<Response> {
  const swapId = req.nextUrl.searchParams.get("swapId");
  if (!swapId) {
    return new Response("swapId query param required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Helper: write an SSE frame
      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Replay any messages that arrived before the client connected
      const existing = swapStore.get(swapId);
      if (existing) {
        for (const msg of existing.messages) send("message", msg);
        send("stateChange", { swapId, state: existing.state });
        if (existing.settledAt) {
          send("complete", existing);
          controller.close();
          return;
        }
      } else {
        swapStore.init(swapId);
      }

      // Subscribe to future updates
      const unsubscribe = swapStore.subscribe(swapId, (event, payload) => {
        send(event, payload);
        if (event === "complete" || event === "error") {
          unsubscribe();
          controller.close();
        }
      });

      // Keep-alive ping every 15s to prevent proxy timeouts
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { clearInterval(ping); }
      }, 15_000);

      // Cleanup on client disconnect
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    },
  });
}
