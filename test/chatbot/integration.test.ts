/**
 * Chatbot integration tests (mock tier)
 *
 * Mocks both Anthropic SDK and sdk-bridge for deterministic, fast, free tests.
 * Starts a real HTTP server on a random port and sends POST /api/chat requests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MockAnthropicStream,
  chatRequest,
  MOCK_POSITIONS,
  MOCK_ACCOUNT_SUMMARY,
  MOCK_BATCH_RESULT,
  MOCK_SL_RESULT,
  MOCK_TP_RESULT,
  MOCK_OPEN_RESULT,
  MOCK_BATCH_ORDERS,
  MOCK_LIQUIDATION_ANALYSIS,
  type SSEEvent,
} from "./helpers.js";

// ─── Module Mocks (hoisted) ───

// vi.hoisted runs before vi.mock factories, making mockStreamFn available
const { mockStreamFn } = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
}));

// sdk-bridge: all exports become vi.fn()
vi.mock("../../src/chatbot/sdk-bridge.js", () => ({
  getLastBatchOrders: vi.fn(),
  clearLastBatchOrders: vi.fn(),
  batchOpenPositions: vi.fn(),
  setStopLoss: vi.fn(),
  setTakeProfit: vi.fn(),
  getAccountSummary: vi.fn(),
  getPositions: vi.fn(),
  getMarkets: vi.fn(),
  getOpenOrders: vi.fn(),
  getFundingInfo: vi.fn(),
  getLiquidationAnalysis: vi.fn(),
  getTradingFees: vi.fn(),
  getOrderbook: vi.fn(),
  getRecentTrades: vi.fn(),
  debugTransaction: vi.fn(),
  simulateStrategy: vi.fn(),
  dryRunTrade: vi.fn(),
  openPosition: vi.fn(),
  closePosition: vi.fn(),
  cancelOrder: vi.fn(),
  depositCollateral: vi.fn(),
  withdrawCollateral: vi.fn(),
  initSDK: vi.fn(),
}));

// Anthropic SDK: mock constructor returns object with messages.stream
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: mockStreamFn },
  })),
}));

// Import after mocking
import { startServer } from "../../src/chatbot/server.js";
import * as bridge from "../../src/chatbot/sdk-bridge.js";

// ─── Test Setup ───

let server: Server;
let port: number;

beforeAll(async () => {
  // Start server on port 0 → OS picks a free port
  server = startServer(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers ───

function findEvents(events: SSEEvent[], type: string): SSEEvent[] {
  return events.filter((e) => e.event === type);
}

function findEvent(events: SSEEvent[], type: string): SSEEvent | undefined {
  return events.find((e) => e.event === type);
}

// ─── Direct Handlers ───

describe("direct handlers (bypass Claude)", () => {
  it('"place orders" with stored batch calls batchOpenPositions', async () => {
    vi.mocked(bridge.getLastBatchOrders).mockReturnValue(MOCK_BATCH_ORDERS);
    vi.mocked(bridge.batchOpenPositions).mockResolvedValue(MOCK_BATCH_RESULT);

    const { status, events } = await chatRequest(port, [
      { role: "user", content: "place orders" },
    ]);

    expect(status).toBe(200);
    expect(bridge.batchOpenPositions).toHaveBeenCalledWith(MOCK_BATCH_ORDERS);
    expect(bridge.clearLastBatchOrders).toHaveBeenCalled();

    // Should NOT call Anthropic
    expect(mockStreamFn).not.toHaveBeenCalled();

    // SSE events: text, tool_call, tool_result, text, assistant_message, done
    expect(findEvent(events, "tool_call")).toBeDefined();
    expect(findEvent(events, "tool_result")).toBeDefined();
    expect(findEvent(events, "done")).toBeDefined();
    expect((findEvent(events, "tool_call")!.data as Record<string, unknown>).name).toBe(
      "batch_open_positions",
    );
  });

  it('"place orders" with no stored batch falls through to Claude', async () => {
    vi.mocked(bridge.getLastBatchOrders).mockReturnValue(undefined);
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [{ type: "text", text: "No orders stored." }],
        stopReason: "end_turn",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "place orders" },
    ]);

    expect(mockStreamFn).toHaveBeenCalled();
    expect(bridge.batchOpenPositions).not.toHaveBeenCalled();
    expect(findEvent(events, "done")).toBeDefined();
  });

  it('"place orders" error emits error text, does NOT clear orders', async () => {
    vi.mocked(bridge.getLastBatchOrders).mockReturnValue(MOCK_BATCH_ORDERS);
    vi.mocked(bridge.batchOpenPositions).mockRejectedValue(
      new Error("insufficient margin"),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "place orders" },
    ]);

    expect(bridge.clearLastBatchOrders).not.toHaveBeenCalled();

    const textEvents = findEvents(events, "text");
    const hasError = textEvents.some((e) =>
      ((e.data as Record<string, unknown>).text as string).includes("insufficient margin"),
    );
    expect(hasError).toBe(true);
    expect(findEvent(events, "done")).toBeDefined();
  });

  it('"sl btc at 92000" calls setStopLoss, Claude NOT called', async () => {
    vi.mocked(bridge.setStopLoss).mockResolvedValue(MOCK_SL_RESULT);

    const { events } = await chatRequest(port, [
      { role: "user", content: "sl btc at 92000" },
    ]);

    expect(bridge.setStopLoss).toHaveBeenCalledWith({
      market: "btc",
      trigger_price: 92000,
    });
    expect(mockStreamFn).not.toHaveBeenCalled();
    expect(findEvent(events, "tool_call")).toBeDefined();
    expect((findEvent(events, "tool_call")!.data as Record<string, unknown>).name).toBe(
      "set_stop_loss",
    );
    expect(findEvent(events, "done")).toBeDefined();
  });

  it('"tp btc at 110000" calls setTakeProfit, Claude NOT called', async () => {
    vi.mocked(bridge.setTakeProfit).mockResolvedValue(MOCK_TP_RESULT);

    const { events } = await chatRequest(port, [
      { role: "user", content: "tp btc at 110000" },
    ]);

    expect(bridge.setTakeProfit).toHaveBeenCalledWith({
      market: "btc",
      trigger_price: 110000,
    });
    expect(mockStreamFn).not.toHaveBeenCalled();
    expect((findEvent(events, "tool_call")!.data as Record<string, unknown>).name).toBe(
      "set_take_profit",
    );
    expect(findEvent(events, "done")).toBeDefined();
  });

  it('"sl btc at 92000" error emits error text', async () => {
    vi.mocked(bridge.setStopLoss).mockRejectedValue(
      new Error("No open position in BTC"),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "sl btc at 92000" },
    ]);

    const textEvents = findEvents(events, "text");
    const hasError = textEvents.some((e) =>
      ((e.data as Record<string, unknown>).text as string).includes("No open position"),
    );
    expect(hasError).toBe(true);
    expect(findEvent(events, "done")).toBeDefined();
  });
});

// ─── Tool-Use Loop ───

describe("tool-use loop", () => {
  it("read-only tool: Claude calls get_positions (2-round loop)", async () => {
    vi.mocked(bridge.getPositions).mockResolvedValue(MOCK_POSITIONS);

    // Round 1: Claude requests tool use
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          { type: "tool_use", id: "call_1", name: "get_positions", input: {} },
        ],
        stopReason: "tool_use",
      }),
    );

    // Round 2: Claude responds with text after seeing results
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          {
            type: "text",
            text: "You have 1 open position: BTC long 0.01 @ $78,000",
          },
        ],
        stopReason: "end_turn",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "show positions" },
    ]);

    expect(bridge.getPositions).toHaveBeenCalled();
    expect(mockStreamFn).toHaveBeenCalledTimes(2);

    // Verify SSE events
    expect(findEvent(events, "tool_call")).toBeDefined();
    expect(findEvent(events, "tool_result")).toBeDefined();
    const textEvents = findEvents(events, "text");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(findEvent(events, "done")).toBeDefined();
  });

  it("write tool guard: skips analysis tool bundled with write tool", async () => {
    vi.mocked(bridge.openPosition).mockResolvedValue(MOCK_OPEN_RESULT);

    // Claude returns open_position + get_liquidation_analysis in same turn
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          {
            type: "tool_use",
            id: "call_write",
            name: "open_position",
            input: { market: "btc", side: "long", size: 0.01, price: 78000, leverage: 5 },
          },
          {
            type: "tool_use",
            id: "call_analysis",
            name: "get_liquidation_analysis",
            input: { market: "btc" },
          },
        ],
        stopReason: "tool_use",
      }),
    );

    // Round 2: Claude responds after seeing results
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [{ type: "text", text: "Position opened." }],
        stopReason: "end_turn",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "long 0.01 btc at 78000 5x" },
    ]);

    // open_position called, get_liquidation_analysis NOT called
    expect(bridge.openPosition).toHaveBeenCalled();
    expect(bridge.getLiquidationAnalysis).not.toHaveBeenCalled();

    // tool_call events emitted only for open_position (skipped tools don't get tool_call SSE)
    const toolCalls = findEvents(events, "tool_call");
    expect(toolCalls.length).toBe(1);
    expect((toolCalls[0].data as Record<string, unknown>).name).toBe("open_position");
  });

  it("direct-return tool: get_liquidation_analysis emits report, stream called once", async () => {
    const liqResult = {
      ...MOCK_LIQUIDATION_ANALYSIS,
      _report: "<div>Liquidation Report HTML</div>",
    };
    vi.mocked(bridge.getLiquidationAnalysis).mockResolvedValue(liqResult as never);

    // Claude calls get_liquidation_analysis
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          {
            type: "tool_use",
            id: "call_liq",
            name: "get_liquidation_analysis",
            input: { market: "btc" },
          },
        ],
        stopReason: "tool_use",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "btc liquidation analysis" },
    ]);

    // Stream called only ONCE (direct-return tools skip the second Claude round)
    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    expect(bridge.getLiquidationAnalysis).toHaveBeenCalledWith("btc");

    // Report SSE event emitted
    const reportEvent = findEvent(events, "report");
    expect(reportEvent).toBeDefined();
    expect((reportEvent!.data as Record<string, unknown>).html).toContain(
      "Liquidation Report HTML",
    );

    // Follow-up text with SL/TP suggestions (from getDirectFollowUp)
    const textEvents = findEvents(events, "text");
    const hasSuggestion = textEvents.some((e) =>
      ((e.data as Record<string, unknown>).text as string).includes("sl btc"),
    );
    expect(hasSuggestion).toBe(true);

    expect(findEvent(events, "done")).toBeDefined();
  });

  it("error in tool: getPositions throws → tool_result contains error", async () => {
    vi.mocked(bridge.getPositions).mockRejectedValue(new Error("RPC timeout"));

    // Round 1: Claude requests tool use
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          { type: "tool_use", id: "call_err", name: "get_positions", input: {} },
        ],
        stopReason: "tool_use",
      }),
    );

    // Round 2: Claude handles the error gracefully
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          { type: "text", text: "Sorry, I couldn't fetch positions due to an RPC error." },
        ],
        stopReason: "end_turn",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "show positions" },
    ]);

    // tool_result should contain the error
    const toolResult = findEvent(events, "tool_result");
    expect(toolResult).toBeDefined();
    const resultData = toolResult!.data as Record<string, unknown>;
    expect((resultData.result as Record<string, unknown>).error).toBe("RPC timeout");

    // Claude still responds
    expect(mockStreamFn).toHaveBeenCalledTimes(2);
    expect(findEvent(events, "done")).toBeDefined();
  });
});

// ─── Text-Only Responses ───

describe("text-only responses", () => {
  it('"help" returns text events, no tool_call events', async () => {
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [
          {
            type: "text",
            text: "**Portfolio**: `show account` `show positions`\n**Trading**: `long 0.01 btc at 78000 5x`",
          },
        ],
        stopReason: "end_turn",
      }),
    );

    const { events } = await chatRequest(port, [
      { role: "user", content: "help" },
    ]);

    expect(findEvents(events, "tool_call").length).toBe(0);
    expect(findEvents(events, "text").length).toBeGreaterThan(0);
    expect(findEvent(events, "assistant_message")).toBeDefined();
    expect(findEvent(events, "done")).toBeDefined();
  });
});

// ─── History Trimming ───

describe("history trimming", () => {
  it("20 messages, generic query → trimmed to MAX_HISTORY (6)", async () => {
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [{ type: "text", text: "Here is the current BTC price." }],
        stopReason: "end_turn",
      }),
    );

    // Build 20 messages (10 exchanges)
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `message ${i}` });
      messages.push({ role: "assistant", content: `reply ${i}` });
    }
    // Override last user message
    messages[messages.length - 1] = { role: "user", content: "what is btc price" };
    // Ensure last message is user
    messages.push({ role: "user", content: "what is btc price" });

    await chatRequest(port, messages);

    // The messages passed to Anthropic should be trimmed
    const streamCallArgs = mockStreamFn.mock.calls[0][0];
    expect(streamCallArgs.messages.length).toBe(6);
  });

  it('20 messages, "yes proceed" → trimmed to MAX_HISTORY_CONTEXTUAL (16)', async () => {
    mockStreamFn.mockReturnValueOnce(
      new MockAnthropicStream({
        content: [{ type: "text", text: "Executing." }],
        stopReason: "end_turn",
      }),
    );

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `message ${i}` });
      messages.push({ role: "assistant", content: `reply ${i}` });
    }
    messages.push({ role: "user", content: "yes proceed" });

    await chatRequest(port, messages);

    const streamCallArgs = mockStreamFn.mock.calls[0][0];
    expect(streamCallArgs.messages.length).toBe(16);
  });
});

// ─── Request Validation ───

describe("request validation", () => {
  it("GET /api/chat → 405", async () => {
    const res = await fetch(`http://localhost:${port}/api/chat`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  it("invalid JSON body → 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid request body");
  });

  it("body without messages array → 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: "not an array" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("messages must be an array");
  });
});
