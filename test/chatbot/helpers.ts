/**
 * Shared test helpers for chatbot integration tests.
 *
 * Provides MockAnthropicStream (simulates client.messages.stream()),
 * SSE response parser, HTTP request helper, and fixture data.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ─── SSE Types ───

export interface SSEEvent {
  event: string;
  data: unknown;
}

// ─── MockAnthropicStream ───

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface MockStreamConfig {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
}

/**
 * Simulates the object returned by `client.messages.stream()`.
 * - AsyncIterable: yields content_block_start / content_block_delta events
 * - `.finalMessage()` returns the complete Anthropic.Message
 */
export class MockAnthropicStream {
  private config: MockStreamConfig;

  constructor(config: MockStreamConfig) {
    this.config = config;
  }

  async *[Symbol.asyncIterator]() {
    let blockIndex = 0;
    for (const block of this.config.content) {
      if (block.type === "text") {
        yield {
          type: "content_block_start" as const,
          index: blockIndex,
          content_block: { type: "text" as const, text: "" },
        };
        // Emit entire text as a single delta (sufficient for tests)
        yield {
          type: "content_block_delta" as const,
          index: blockIndex,
          delta: { type: "text_delta" as const, text: block.text },
        };
      }
      // tool_use blocks don't emit deltas in the event stream —
      // they appear only in finalMessage().content
      blockIndex++;
    }
  }

  async finalMessage(): Promise<Anthropic.Message> {
    const contentBlocks: Anthropic.ContentBlock[] = this.config.content.map(
      (block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text } as Anthropic.TextBlock;
        }
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        } as Anthropic.ToolUseBlock;
      },
    );

    return {
      id: "msg_mock_" + Date.now(),
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: contentBlocks,
      stop_reason: this.config.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    } as Anthropic.Message;
  }
}

// ─── SSE Parser ───

export async function parseSSEResponse(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  const events: SSEEvent[] = [];

  // Split on double newlines to get individual SSE frames
  const frames = text.split("\n\n").filter((f) => f.trim().length > 0);

  for (const frame of frames) {
    let eventType = "";
    let dataStr = "";

    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      }
    }

    if (eventType && dataStr) {
      try {
        events.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        events.push({ event: eventType, data: dataStr });
      }
    }
  }

  return events;
}

// ─── Chat Request Helper ───

export async function chatRequest(
  port: number,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{ status: number; events: SSEEvent[] }> {
  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  const events = await parseSSEResponse(res);
  return { status: res.status, events };
}

// ─── Fixture Data ───

export const MOCK_POSITIONS = [
  {
    market: "BTC",
    side: "long",
    size: 0.01,
    entryPrice: 78000,
    markPrice: 80000,
    unrealizedPnl: 20,
    unrealizedPnlPercent: 25.64,
    margin: 78,
    leverage: 10,
  },
];

export const MOCK_ACCOUNT_SUMMARY = {
  accountId: "42",
  balance: 1000,
  lockedBalance: 78,
  availableBalance: 922,
  totalEquity: 1020,
  unrealizedPnl: 20,
  marginUsed: 78,
  marginAvailable: 922,
};

export const MOCK_MARKETS = [
  {
    market: "BTC",
    markPrice: 80000,
    oraclePrice: 79950,
    fundingRate: 0.0001,
    longOpenInterest: 100,
    shortOpenInterest: 95,
    paused: false,
  },
];

export const MOCK_LIQUIDATION_ANALYSIS = {
  market: "BTC",
  side: "long",
  size: 0.01,
  entryPrice: 78000,
  liquidationPrice: 70200,
  distancePct: 12.5,
  distanceUsd: 9800,
  currentMarkPrice: 80000,
  currentPnl: 20,
  currentEquity: 98,
};

export const MOCK_BATCH_RESULT = {
  totalOrders: 3,
  successful: 3,
  failed: 0,
  txHash: "0xabc123",
  results: [
    { success: true, txHash: "0xabc123", market: "BTC", side: "long", size: 0.001, price: 77000, leverage: 2 },
    { success: true, txHash: "0xabc123", market: "BTC", side: "short", size: 0.001, price: 79000, leverage: 2 },
    { success: true, txHash: "0xabc123", market: "BTC", side: "long", size: 0.001, price: 76000, leverage: 2 },
  ],
};

export const MOCK_SL_RESULT = {
  success: true,
  requestId: 12345,
  type: "Stop Loss",
  market: "BTC",
  side: "long",
  triggerPrice: 92000,
  size: 0.01,
  triggerCondition: "price <= trigger",
};

export const MOCK_TP_RESULT = {
  success: true,
  requestId: 12346,
  type: "Take Profit",
  market: "BTC",
  side: "long",
  triggerPrice: 110000,
  size: 0.01,
  triggerCondition: "price >= trigger",
};

export const MOCK_OPEN_RESULT = {
  success: true,
  txHash: "0xdef456",
  market: "BTC",
  side: "long",
  size: 0.01,
  price: 78000,
  leverage: 5,
  type: "limit",
};

export const MOCK_BATCH_ORDERS = [
  { market: "BTC", side: "long" as const, size: 0.001, price: 77000, leverage: 2 },
  { market: "BTC", side: "short" as const, size: 0.001, price: 79000, leverage: 2 },
  { market: "BTC", side: "long" as const, size: 0.001, price: 76000, leverage: 2 },
];

// ─── Assistant Text Extractor ───

export function extractAssistantText(events: SSEEvent[]): string {
  const msg = events.find((e) => e.event === "assistant_message");
  if (msg) return (msg.data as Record<string, unknown>).text as string;
  return events
    .filter((e) => e.event === "text")
    .map((e) => (e.data as Record<string, unknown>).text as string)
    .join("");
}
