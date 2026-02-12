# Test Coverage Plan — Remaining Gaps

## Context

The testnet trading integration tests (`test/chatbot/trading.testnet.ts`) now cover all sdk-bridge trading functions in delegate/operator mode (47 tests). The unit test suite has 551 tests. This plan covers the remaining untested areas.

## Current State

- **Delegate mode active**: `.env` has `OPERATOR_PRIVATE_KEY` + `DELEGATED_ACCOUNT_ADDRESS` uncommented
- **WebSocket not connected in operator mode**: Operator wallet times out on API auth (`Timeout waiting for wallet snapshot`). SL/TP and market/IOC tests skip gracefully.
- **`execOrders` (batch) reverts**: Exchange contract limitation — `execOrders` selector `0xaf3176da` is allowlisted on the DelegatedAccount but the Exchange contract itself rejects it for user accounts. Not a code bug.
- **Testnet trading tests**: Opt-in via `CHATBOT_TRADING_TEST=1`, not run during `npm test`

## Priority 1: Testnet Integration Tests (Real Chain)

### 1a. `depositCollateral` / `withdrawCollateral`
- **File**: `test/chatbot/trading.testnet.ts` (add new section)
- **What**: Deposit a small amount (e.g. 1 AUSD), verify balance increased, withdraw same amount, verify balance restored
- **Why**: Real fund movement — high risk if broken
- **Gate**: `CHATBOT_TRADING_TEST=1` (same as existing)
- **Key functions**: `sdk-bridge.ts:731` (`depositCollateral`), `sdk-bridge.ts:741` (`withdrawCollateral`)
- **Note**: These are owner-only operations. In operator mode, `withdrawCollateral` should be blocked by the DelegatedAccount (operator cannot withdraw). Test BOTH: verify deposit works AND verify withdraw is blocked in operator mode. May need to test deposit in owner mode separately.

### 1b. `debugTransaction`
- **File**: `test/chatbot/trading.testnet.ts` (add new section)
- **What**: After any successful trade in the test, capture the txHash and pass it to `debugTransaction()`. Verify it returns decoded events, gas info, and a readable summary.
- **Why**: Forensics is a key feature, zero e2e coverage
- **Key function**: `sdk-bridge.ts:931` (`debugTransaction`)
- **Depends on**: A successful trade tx from earlier in the test suite. Store the txHash from a BTC open/close and reuse.

## Priority 2: Unit Tests (Mocked, Fast)

### 2a. `chatbot/tools.ts` — `executeTool` routing
- **File**: `test/chatbot/tools.test.ts` (new)
- **What**: Mock sdk-bridge, call `executeTool("get_positions", {})`, verify it calls `getPositions()` and returns the result. Test all 16 tool names.
- **Why**: This is the routing layer between Claude and the SDK. If a tool name is misrouted, the chatbot breaks silently.
- **Pattern**: Similar to `test/chatbot/live.test.ts` — mock sdk-bridge, import tools, call `executeTool`
- **Key function**: `tools.ts:116` (`executeTool`)
- **Tools to test**: `get_positions`, `get_account_summary`, `get_markets`, `get_open_orders`, `get_funding_info`, `open_position`, `close_position`, `cancel_order`, `batch_open_positions`, `set_stop_loss`, `set_take_profit`, `deposit_collateral`, `withdraw_collateral`, `get_liquidation_analysis`, `get_trading_fees`, `get_orderbook`, `get_recent_trades`, `debug_transaction`, `simulate_strategy`, `dry_run_trade`

### 2b. `sdk/config.ts` — Config loading
- **File**: `test/config.test.ts` (new)
- **What**: Test `loadEnvConfig()` with various env var combinations. Test `validateOwnerConfig()` and `validateOperatorConfig()` throw on missing keys.
- **Why**: Config errors cause cryptic failures at runtime
- **Approach**: Set `process.env` values in beforeEach, restore in afterEach

### 2c. `sdk/state/exchange.ts` — ExchangeStateTracker
- **File**: `test/state/exchange.test.ts` (new)
- **What**: Test event subscription, state updates, position tracking
- **Why**: Used for real-time state tracking in the bot, zero coverage
- **Key class**: `ExchangeStateTracker` at `state/exchange.ts:84`

### 2d. `chatbot/ansi-html.ts` — ANSI→HTML conversion
- **File**: `test/chatbot/ansi-html.test.ts` (new)
- **What**: Pass ANSI-colored strings, verify HTML output has correct `<span>` tags with color styles
- **Why**: Renders reports in the chat UI — broken conversion = garbled output

## Priority 3: MCP Server Tests

### 3a. `mcp/server.ts` — Tool registrations
- **File**: `test/mcp/server.test.ts` (new)
- **What**: Import the MCP server, verify all 16 tools are registered with correct schemas. Mock sdk-bridge, call each tool handler, verify routing.
- **Why**: MCP is the integration point for external AI agents

### 3b. `mcp/schemas.ts` — Zod validation
- **File**: `test/mcp/schemas.test.ts` (new)
- **What**: Test each Zod schema with valid/invalid inputs
- **Why**: Bad input validation = runtime crashes in production

## Priority 4: CLI Coverage Gaps

### 4a. `cli/simulate.ts` — Strategy simulation CLI
- **File**: `test/cli/simulate.test.ts` (new)
- **What**: Mock simulation module, test CLI argument parsing and output formatting
- **Pattern**: Same as `test/cli/trade.test.ts` — mock modules, capture console output

### 4b. `cli/show.ts` — `show trades`, `show liquidation`
- **File**: Extend `test/cli/show-book.test.ts`
- **What**: `show trades` and `show liquidation` subcommands are untested

## Implementation Notes

- **Test pattern**: vitest, `NO_COLOR=1` in beforeAll, mock console.log for CLI tests
- **Testnet tests**: Always gate with `describe.skipIf(!process.env.CHATBOT_TRADING_TEST)`
- **Test count**: Currently 551 unit + 47 testnet. Update CLAUDE.md when adding tests.
- **Export collisions**: API module exports `OrderStatus` enum; simulation uses `SimOrderStatus` to avoid clash via barrel exports
- **Operator mode quirks**: API returns 404 for operator wallet (`ApiError: Not found`). Portfolio falls back to contract reads. This is expected — operator wallet isn't whitelisted on the API.

## Verification

After implementing each section:
```bash
# Unit tests still pass
npm test

# Testnet tests still pass (if applicable)
CHATBOT_TRADING_TEST=1 npx vitest run test/chatbot/trading.testnet.ts

# Type check
npm run typecheck
```
