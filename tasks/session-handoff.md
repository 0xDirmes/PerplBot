# Session Handoff — 2026-02-10

## Project
`/Users/pbj/claude/PerplBot/` — AI agent toolkit for automated trading on Perpl (perpetual DEX on Monad).

## Current State
- **Branch**: `main`
- **Latest commit**: `a8d1ee9` — Fix market order fills: verify on-chain instead of WS events, auto-correct slippage direction
- **All 535 tests passing**, typecheck clean
- **Chatbot is stopped** (was running on port 3000, killed by user). Restart with `npm run chatbot`.

## Recent Commits (this session)

| Commit | Description |
|--------|-------------|
| `a8d1ee9` | Fix market order fills: `submitViaApiAndVerify` (WS submit + on-chain position polling), slippage auto-correction |
| `e4a5400` | Route market orders through WS API, fix confirmation flow, add direct SL/TP handlers |
| `72cd424` | Direct return for simulation/analysis tools, USDC→AUSD rename, WebSocket error handling |

## What Was Built This Session

### 1. Direct-Return for Simulation/Analysis Tools
**Files**: `src/chatbot/server.ts`

4 tools with rich reports (`simulate_strategy`, `dry_run_trade`, `debug_transaction`, `get_liquidation_analysis`) bypass Claude's post-processing. The report/data streams directly to the client, and a follow-up prompt is generated locally — no second API call to Claude.

- `DIRECT_RETURN_TOOLS` set in server.ts
- `getDirectFollowUp()` generates tool-specific follow-ups (e.g., "Reply `place orders` to execute")
- Simpler analysis tools (funding, fees, orderbook, trades) still go through Claude for formatting

### 2. Market vs Limit Order Routing
**Files**: `src/chatbot/sdk-bridge.ts`

- **Market/IOC orders** (taking liquidity) → WS API `submitOrder()` for faster matching, no gas
- **Limit/resting orders** (adding liquidity) → on-chain `execOrder()` via SDK contract
- **Cancel orders** → on-chain SDK

### 3. On-Chain Fill Verification (`submitViaApiAndVerify`)
**Files**: `src/chatbot/sdk-bridge.ts`

WS `submitOrder` is fire-and-forget (no fill events pushed). Solution:
1. Submit via WS API
2. Poll on-chain position for up to 10 seconds
3. Compare pre/post position state (lotLNS, positionType) to confirm fill
4. Return `{ filled: boolean, txHash?: string }`

Used by both `openPosition()` and `closePosition()` market paths.

### 4. Slippage Auto-Correction
**Files**: `src/chatbot/sdk-bridge.ts`, `src/chatbot/server.ts`

Claude sometimes sends wrong-direction slippage (e.g., short with price > mark). Auto-correction in `openPosition()`:
- Long with price < 95% of mark → recalculate to mark * 1.015
- Short with price > 105% of mark → recalculate to mark * 0.985

System prompt updated: "LONG +1-2% (max buy price), SHORT -1-2% (min sell price)"

### 5. Trade Confirmation Flow
**Files**: `src/chatbot/server.ts`

- System prompt enforces: first mention → preview only (NEVER execute), user re-enters → execute
- Code-level write-tool guard: when Claude bundles write tools (open/close/cancel) with analysis tools in the same turn, only write tools execute
- Direct handlers for `sl`/`tp` commands (regex-parsed, bypass Claude entirely)
- Direct handler for `place orders` (executes batch from simulate_strategy)

### 6. USDC → AUSD Rename
**Files**: 7 simulation report files + telegram formatter + chatbot system prompt

All user-facing references to "USDC" changed to "AUSD" (the collateral token name).

## Key Architecture (Chatbot)

```
Browser (public/index.html)
    │  POST /api/chat (SSE stream)
    ▼
server.ts
    ├── Direct handlers: "place orders", "sl <market> at <price>", "tp <market> at <price>"
    ├── Direct-return tools: simulate_strategy, dry_run_trade, debug_transaction, get_liquidation_analysis
    ├── Claude tool-use loop: all other requests
    │       ├── Write-tool guard (skip analysis when bundled with trades)
    │       └── System prompt with trade confirmation rules
    ▼
sdk-bridge.ts (singleton SDK)
    ├── openPosition() → market: WS API + on-chain verify | limit: on-chain SDK
    ├── closePosition() → market: WS API + on-chain verify | limit: on-chain SDK
    ├── setStopLoss() / setTakeProfit() → WS API trigger orders
    ├── batchOpenPositions() → on-chain SDK
    └── 12 other query/analysis functions
```

## Known Issues / Watch Items

1. **`submitViaApiAndVerify` has no txHash**: The WS API doesn't return a settlement tx hash. The function confirms the fill via position change but `txHash` is undefined. Could be improved by querying recent tx history.

2. **On-chain polling timeout (10s)**: If the matching engine is slow or order doesn't fill, the 10s timeout returns `{ filled: false }`. The chatbot reports "no fill detected" to the user.

3. **Direct SL/TP handlers are simple regex**: `^(?:sl|stop[\s-]?loss)\s+(\w+)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*$` — doesn't handle all edge cases (e.g., "set stop loss for btc at 60000").

4. **`set_take_profit` and `set_stop_loss` tools**: These are also available via Claude tool-use (not just direct handlers). The direct handlers exist because Claude sometimes fails to call them.

5. **MCP server plan exists** (see below) but is already implemented (`dda32a9`). The plan file at `~/.claude/plans/shiny-knitting-stream.md` can be cleaned up.

## Pending Plan

The MCP server plan at `~/.claude/plans/shiny-knitting-stream.md` is **already complete** — implemented in commit `dda32a9`. No pending implementation work from that plan.

## File Quick Reference

| File | Purpose |
|------|---------|
| `src/chatbot/index.ts` | Chatbot entry point — init SDK, start HTTP server |
| `src/chatbot/sdk-bridge.ts` | SDK singleton + all 16 tool wrapper functions |
| `src/chatbot/server.ts` | HTTP server, SSE streaming, Claude tool-use loop, direct handlers |
| `src/chatbot/tools.ts` | Claude tool definitions (names, descriptions, JSON schemas) |
| `src/chatbot/ansi-html.ts` | ANSI → HTML conversion for reports |
| `src/chatbot/public/index.html` | Self-contained chat UI |
| `src/mcp/` | MCP server (separate process, same sdk-bridge functions) |
| `src/sdk/api/websocket.ts` | WS client — `submitOrder()`, event handling |
| `src/sdk/api/types.ts` | API types — OrderRequest, OrderStatus, OrderFlags |

## How to Resume

```bash
cd /Users/pbj/claude/PerplBot
npm run chatbot          # Start chatbot on port 3000
npm run mcp              # Start MCP server on port 3001
npm test                 # Run all 535 tests
npm run typecheck        # TypeScript check
```

## Lessons from This Session

- **WS trading connection doesn't auto-push order events**: Don't listen for fill events on the WS — use on-chain polling instead.
- **Claude gets slippage direction wrong for shorts**: Always auto-correct in code, don't rely on prompt engineering alone.
- **Claude bundles analysis with trade execution**: Code-level guard needed (write-tool guard) in addition to system prompt.
- **Direct command handlers are more reliable than Claude**: For critical actions (SL/TP, place orders), regex-based direct handlers bypass Claude's non-determinism.
- **Fire-and-forget WS orders need verification**: `submitOrder` returns immediately — must verify fill on-chain.
