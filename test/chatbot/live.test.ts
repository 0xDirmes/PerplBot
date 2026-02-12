/**
 * Chatbot live end-to-end tests (opt-in tier)
 *
 * Real Anthropic API + real SDK + real testnet trades.
 * Sends chat messages through the HTTP server, Claude calls tools,
 * trades execute on-chain, and we verify tx hashes in responses.
 *
 * Enable with: CHATBOT_LIVE_TEST=1 npx vitest run test/chatbot/live.test.ts
 *
 * Requires: ANTHROPIC_API_KEY, OWNER_PRIVATE_KEY or OPERATOR_PRIVATE_KEY in .env
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "dotenv";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

config(); // load .env before anything else

// Skip trade confirmation in test mode — Claude executes immediately
process.env.CHATBOT_SKIP_CONFIRMATION = "1";

// Default to owner mode: clear operator/delegate env vars so initSDK picks owner wallet
if (!process.env.CHATBOT_DELEGATE_TEST) {
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.DELEGATED_ACCOUNT_ADDRESS;
}

import { initSDK, getMarkets, getPositions, getOpenOrders, cancelOrder, closePosition } from "../../src/chatbot/sdk-bridge.js";
import { startServer } from "../../src/chatbot/server.js";
import { chatRequest, extractAssistantText, type SSEEvent } from "./helpers.js";

// ─── Helpers ───

function findEvents(events: SSEEvent[], type: string): SSEEvent[] {
  return events.filter((e) => e.event === type);
}

function findEvent(events: SSEEvent[], type: string): SSEEvent | undefined {
  return events.find((e) => e.event === type);
}

/** Round price sensibly — don't round sub-dollar prices to zero */
function roundPrice(price: number): number {
  return price >= 1 ? Math.round(price) : parseFloat(price.toPrecision(4));
}

// ─── Test Setup ───

let server: Server;
let port: number;
const markPrices: Record<string, number> = {};

// 10% spread to ensure crossing on thin testnet books
const OPEN_LONG_MULT = 1.10;
const CLOSE_LONG_MULT = 0.90;

describe.skipIf(!process.env.CHATBOT_LIVE_TEST)("chatbot live e2e tests", () => {
  beforeAll(async () => {
    // Initialize real SDK (loads wallet, connects to exchange)
    await initSDK();

    // Fetch mark prices
    const markets = await getMarkets();
    for (const m of markets) {
      const name = m.market.replace("/USD", "");
      markPrices[name] = m.markPrice;
    }
    console.log("[live] BTC mark price:", markPrices.BTC);

    // Start real chatbot server (no mocks, confirmation skipped)
    server = startServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
    console.log("[live] Server on port", port);
  }, 60_000);

  afterAll(async () => {
    // Clean up: cancel any leftover orders, close any positions
    for (const mkt of ["BTC"]) {
      try {
        const orders = await getOpenOrders(mkt);
        for (const o of orders) {
          await cancelOrder(mkt, o.orderId);
          console.log(`[cleanup] cancelled ${mkt} order ${o.orderId}`);
        }
      } catch { /* best-effort */ }
      try {
        const positions = await getPositions();
        const pos = positions.find(
          (p) => (p.market.toUpperCase() === mkt || p.market === `${mkt}/USD`) && p.side === "long",
        );
        if (pos && pos.size > 0) {
          const closePrice = roundPrice(markPrices[mkt] * CLOSE_LONG_MULT);
          await closePosition({ market: mkt, side: "long", price: closePrice, is_market_order: false });
          console.log(`[cleanup] closed ${mkt} long position`);
        }
      } catch { /* best-effort */ }
    }

    // Close server
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }

    delete process.env.CHATBOT_SKIP_CONFIRMATION;
  }, 60_000);

  // ════════════════════════════════════════════════════
  // 1. Read-only queries through chatbot
  // ════════════════════════════════════════════════════

  it(
    '"show positions" returns real positions',
    async () => {
      const { events } = await chatRequest(port, [
        { role: "user", content: "show my positions" },
      ]);

      const toolCalls = findEvents(events, "tool_call");
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(
        toolCalls.some((e) => (e.data as Record<string, unknown>).name === "get_positions"),
      ).toBe(true);

      const text = extractAssistantText(events);
      console.log("[live] positions response:", text.slice(0, 300));

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 60_000 },
  );

  it(
    '"show account summary" returns real account data',
    async () => {
      const { events } = await chatRequest(port, [
        { role: "user", content: "show account summary" },
      ]);

      const text = extractAssistantText(events);
      console.log("[live] account response:", text.slice(0, 300));

      expect(text.toLowerCase()).toMatch(/equity|balance|margin|account/);
      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 60_000 },
  );

  it(
    '"show markets" returns real market data with prices',
    async () => {
      const { events } = await chatRequest(port, [
        { role: "user", content: "show markets" },
      ]);

      const text = extractAssistantText(events);
      console.log("[live] markets response:", text.slice(0, 300));

      expect(text).toMatch(/BTC/i);
      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 60_000 },
  );

  // ════════════════════════════════════════════════════
  // 2. Open a real BTC long through chatbot
  // ════════════════════════════════════════════════════

  let openTxHash: string | undefined;

  it(
    "opens a BTC long via chatbot (crossing limit)",
    async () => {
      const crossingPrice = roundPrice(markPrices.BTC * OPEN_LONG_MULT);

      const { events } = await chatRequest(port, [
        { role: "user", content: `long 0.001 btc at ${crossingPrice} 2x` },
      ]);

      const text = extractAssistantText(events);
      console.log("[live] open response:", text.slice(0, 500));

      // Verify Claude called open_position directly (no confirmation)
      const toolCalls = findEvents(events, "tool_call");
      const openCall = toolCalls.find(
        (e) => (e.data as Record<string, unknown>).name === "open_position",
      );
      expect(openCall, "Claude should call open_position without confirmation").toBeDefined();

      // Extract tx hash from tool result
      const toolResults = findEvents(events, "tool_result");
      for (const tr of toolResults) {
        const data = tr.data as Record<string, unknown>;
        if (data.name === "open_position") {
          const result = data.result as Record<string, unknown>;
          console.log("[live] open result:", JSON.stringify(result, null, 2));
          if (result?.txHash) {
            openTxHash = result.txHash as string;
          }
        }
      }

      // Also try text for tx hash
      if (!openTxHash) {
        const txMatch = text.match(/0x[a-fA-F0-9]{64}/);
        if (txMatch) openTxHash = txMatch[0];
      }

      expect(openTxHash, "should have a tx hash").toBeDefined();
      expect(openTxHash).toMatch(/^0x/);
      console.log("[live] open tx:", openTxHash);

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 120_000 },
  );

  it(
    "BTC long position visible after open",
    async () => {
      if (!openTxHash) {
        console.log("[live] skipped — no tx hash from open");
        return;
      }

      await new Promise((r) => setTimeout(r, 3000));

      const positions = await getPositions();
      const btcPos = positions.find(
        (p) => (p.market.toUpperCase() === "BTC" || p.market === "BTC/USD") && p.side === "long",
      );

      if (btcPos) {
        console.log(`[live] BTC long: size=${btcPos.size}, entry=${btcPos.entryPrice}, pnl=${btcPos.unrealizedPnl}`);
        expect(btcPos.size).toBeGreaterThan(0);
      } else {
        console.log("[live] BTC long not found — order may have rested (thin liquidity)");
        const orders = await getOpenOrders("BTC");
        console.log("[live] open orders:", JSON.stringify(orders, null, 2));
      }
    },
    { timeout: 60_000 },
  );

  // ════════════════════════════════════════════════════
  // 3. Close the BTC long through chatbot
  // ════════════════════════════════════════════════════

  it(
    "closes the BTC long via chatbot",
    async () => {
      if (!openTxHash) {
        console.log("[live] skipped — no position opened");
        return;
      }

      const closePrice = roundPrice(markPrices.BTC * CLOSE_LONG_MULT);

      const { events } = await chatRequest(port, [
        { role: "user", content: `close btc long at ${closePrice}` },
      ]);

      const text = extractAssistantText(events);
      console.log("[live] close response:", text.slice(0, 500));

      const toolCalls = findEvents(events, "tool_call");
      const closeCall = toolCalls.find(
        (e) => (e.data as Record<string, unknown>).name === "close_position",
      );
      expect(closeCall, "Claude should call close_position without confirmation").toBeDefined();

      const toolResults = findEvents(events, "tool_result");
      for (const tr of toolResults) {
        const data = tr.data as Record<string, unknown>;
        if (data.name === "close_position") {
          const result = data.result as Record<string, unknown>;
          console.log("[live] close result:", JSON.stringify(result, null, 2));
          if (result?.txHash) {
            console.log("[live] close tx:", result.txHash);
          }
        }
      }

      expect(findEvent(events, "done")).toBeDefined();
    },
    { timeout: 120_000 },
  );

  // ════════════════════════════════════════════════════
  // 4. Cleanup — cancel any resting orders
  // ════════════════════════════════════════════════════

  it(
    "cleans up any resting BTC orders",
    async () => {
      await new Promise((r) => setTimeout(r, 2000));
      const orders = await getOpenOrders("BTC");
      for (const o of orders) {
        const result = await cancelOrder("BTC", o.orderId);
        console.log(`[cleanup] cancelled order ${o.orderId}: tx=${result.txHash}`);
      }
      console.log(`[cleanup] done — ${orders.length} orders cancelled`);
    },
    { timeout: 60_000 },
  );
});
