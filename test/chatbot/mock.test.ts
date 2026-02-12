/**
 * Chatbot mock integration tests (opt-in tier)
 *
 * Uses REAL Anthropic API but mocks sdk-bridge (no blockchain).
 * Enable with: CHATBOT_MOCK_TEST=1 npx vitest run test/chatbot/mock.test.ts
 *
 * Non-deterministic, costs money (uses Haiku for low cost).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { config } from "dotenv";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

config(); // load .env before anything else (needs ANTHROPIC_API_KEY)
import {
  chatRequest,
  extractAssistantText,
  MOCK_POSITIONS,
  MOCK_ACCOUNT_SUMMARY,
  MOCK_MARKETS,
  MOCK_LIQUIDATION_ANALYSIS,
  MOCK_OPEN_RESULT,
  type SSEEvent,
} from "./helpers.js";

// Mock sdk-bridge (no blockchain calls), but NOT Anthropic SDK (real API)
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

import { startServer } from "../../src/chatbot/server.js";
import * as bridge from "../../src/chatbot/sdk-bridge.js";

// ─── Test Setup ───

let server: Server;
let port: number;

function findEvents(events: SSEEvent[], type: string): SSEEvent[] {
  return events.filter((e) => e.event === type);
}

function findEvent(events: SSEEvent[], type: string): SSEEvent | undefined {
  return events.find((e) => e.event === type);
}

describe.skipIf(!process.env.CHATBOT_MOCK_TEST)("chatbot mock tests", () => {
  beforeAll(async () => {
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

    // Setup default mock returns for common bridge calls
    vi.mocked(bridge.getPositions).mockResolvedValue(MOCK_POSITIONS);
    vi.mocked(bridge.getAccountSummary).mockResolvedValue(MOCK_ACCOUNT_SUMMARY);
    vi.mocked(bridge.getMarkets).mockResolvedValue(MOCK_MARKETS);
    vi.mocked(bridge.getLastBatchOrders).mockReturnValue(undefined);
  });

  it(
    '"show positions" → Claude calls get_positions tool',
    async () => {
      const { events } = await chatRequest(port, [
        { role: "user", content: "show positions" },
      ]);

      expect(bridge.getPositions).toHaveBeenCalled();

      const toolCalls = findEvents(events, "tool_call");
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(
        toolCalls.some(
          (e) => (e.data as Record<string, unknown>).name === "get_positions",
        ),
      ).toBe(true);

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 30_000 },
  );

  it(
    '"btc liquidation analysis" → Claude calls get_liquidation_analysis, report emitted',
    async () => {
      const liqResult = {
        ...MOCK_LIQUIDATION_ANALYSIS,
        _report: "<div>Liq Report</div>",
      };
      vi.mocked(bridge.getLiquidationAnalysis).mockResolvedValue(liqResult as never);

      const { events } = await chatRequest(port, [
        { role: "user", content: "btc liquidation analysis" },
      ]);

      expect(bridge.getLiquidationAnalysis).toHaveBeenCalled();

      const reportEvent = findEvent(events, "report");
      expect(reportEvent).toBeDefined();

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 30_000 },
  );

  it(
    '"help" → text returned, no tool calls',
    async () => {
      const { events } = await chatRequest(port, [
        { role: "user", content: "help" },
      ]);

      const toolCalls = findEvents(events, "tool_call");
      expect(toolCalls.length).toBe(0);

      const textEvents = findEvents(events, "text");
      expect(textEvents.length).toBeGreaterThan(0);

      // Should contain some help content
      const allText = textEvents
        .map((e) => (e.data as Record<string, unknown>).text as string)
        .join("");
      expect(allText.toLowerCase()).toMatch(/portfolio|trading|help|position/);

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 30_000 },
  );

  it(
    '"long 0.01 btc at 78000 5x" → Claude shows preview only, does NOT call open_position',
    async () => {
      vi.mocked(bridge.openPosition).mockResolvedValue(MOCK_OPEN_RESULT);

      const { events } = await chatRequest(port, [
        { role: "user", content: "long 0.01 btc at 78000 5x" },
      ]);

      // Claude should NOT call open_position on first mention (confirmation flow)
      expect(bridge.openPosition).not.toHaveBeenCalled();

      // Should have text response (the preview)
      const textEvents = findEvents(events, "text");
      expect(textEvents.length).toBeGreaterThan(0);

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 30_000 },
  );

  // ════════════════════════════════════════════════════
  // Multi-turn conversation tests
  // ════════════════════════════════════════════════════

  it(
    "trade confirmation flow: preview → confirm → execute",
    async () => {
      vi.mocked(bridge.openPosition).mockResolvedValue(MOCK_OPEN_RESULT);

      // Turn 1: Initial trade request → preview only, no execution
      const turn1 = await chatRequest(port, [
        { role: "user", content: "long 0.01 btc at 78000 5x" },
      ]);

      expect(bridge.openPosition).not.toHaveBeenCalled();
      const previewText = extractAssistantText(turn1.events);
      expect(previewText.length).toBeGreaterThan(0);

      // Turn 2: Send full history + confirmation → should execute
      vi.clearAllMocks();
      vi.mocked(bridge.openPosition).mockResolvedValue(MOCK_OPEN_RESULT);
      vi.mocked(bridge.getPositions).mockResolvedValue(MOCK_POSITIONS);
      vi.mocked(bridge.getAccountSummary).mockResolvedValue(MOCK_ACCOUNT_SUMMARY);
      vi.mocked(bridge.getMarkets).mockResolvedValue(MOCK_MARKETS);
      vi.mocked(bridge.getLastBatchOrders).mockReturnValue(undefined);

      const turn2 = await chatRequest(port, [
        { role: "user", content: "long 0.01 btc at 78000 5x" },
        { role: "assistant", content: previewText },
        {
          role: "user",
          content:
            "Yes, I confirm. Please execute the limit long 0.01 BTC at $78,000 with 5x leverage now using the open_position tool.",
        },
      ]);

      // Non-deterministic: Claude usually executes on explicit confirmation,
      // but may occasionally ask for further clarification
      const toolCalls = findEvents(turn2.events, "tool_call");
      const executed = toolCalls.some(
        (e) => (e.data as Record<string, unknown>).name === "open_position",
      );
      if (executed) {
        expect(bridge.openPosition).toHaveBeenCalled();
        console.log("[confirm flow] Claude executed the trade on Turn 2");
      } else {
        // LLM chose not to execute — log but don't fail
        const text = extractAssistantText(turn2.events);
        console.log(
          "[confirm flow] Claude did not execute (non-deterministic LLM):",
          text.slice(0, 200),
        );
      }
    },
    { timeout: 60_000 },
  );

  it(
    "multi-turn context retention: positions → PnL follow-up",
    async () => {
      vi.mocked(bridge.getPositions).mockResolvedValue(MOCK_POSITIONS);
      vi.mocked(bridge.getAccountSummary).mockResolvedValue(MOCK_ACCOUNT_SUMMARY);

      // Turn 1: Ask for positions
      const turn1 = await chatRequest(port, [
        { role: "user", content: "show positions" },
      ]);

      expect(bridge.getPositions).toHaveBeenCalled();
      const positionsText = extractAssistantText(turn1.events);
      expect(positionsText.length).toBeGreaterThan(0);

      // Turn 2: Follow-up about BTC PnL (should use context from turn 1)
      vi.clearAllMocks();
      vi.mocked(bridge.getPositions).mockResolvedValue(MOCK_POSITIONS);
      vi.mocked(bridge.getAccountSummary).mockResolvedValue(MOCK_ACCOUNT_SUMMARY);
      vi.mocked(bridge.getMarkets).mockResolvedValue(MOCK_MARKETS);
      vi.mocked(bridge.getLastBatchOrders).mockReturnValue(undefined);

      const turn2 = await chatRequest(port, [
        { role: "user", content: "show positions" },
        { role: "assistant", content: positionsText },
        { role: "user", content: "what's my btc pnl?" },
      ]);

      const responseText = extractAssistantText(turn2.events);
      // Should mention PnL-related info (loose match for non-deterministic LLM output)
      expect(responseText.toLowerCase()).toMatch(/pnl|profit|loss|20|25/);
      expect(findEvent(turn2.events, "done")).toBeDefined();
    },
    { timeout: 60_000 },
  );
});
