---
title: "feat: Delta-Neutral Funding Rate Carry Bot (AUSD/BTC)"
type: feat
status: implemented
date: 2026-03-07
deepened: 2026-03-07
brainstorm: docs/brainstorms/2026-03-07-carry-bot-brainstorm.md
---

# Delta-Neutral Funding Rate Carry Bot (AUSD/BTC)

## Enhancement Summary

**Deepened on:** 2026-03-07
**Review agents used:** Architecture, Security, Performance, Type Design, Pattern Consistency, Silent Failure Analysis, Data Integrity, Simplicity/YAGNI, Uniswap V3 Research
**Total findings:** 90+ across all agents

### Key Improvements from Review

1. **Scope reduced ~50%**: Cut Phases 4-5 (Telegram/MCP/simulation), inline TWAP + FundingMonitor, collapse to 5 files ~780 LOC
2. **Security hardening**: Mandatory tx receipt verification, DelegatedAccount before mainnet, swap deadline required, MCP auth
3. **Data integrity**: SQLite TEXT for financial values (not REAL), transaction boundaries, reconciliation state matrix
4. **Performance**: WebSocket funding handler (eliminates 288 RPC calls/day), interleaved TWAP, multicall batching
5. **Uniswap integration**: SwapRouter02 (not Universal), skip Permit2/@uniswap/v3-sdk, direct viem calls

### Critical Pre-Existing Codebase Issues (Fix Before Carry Bot)

| Issue | Location | Impact |
|-------|----------|--------|
| 6 empty catch blocks in WS fallback | `wallet.ts:239-489` | Masks all WebSocket failures silently |
| No tx receipt verification on any write | `Exchange.ts:860-899` | Treats reverted txs as successful |
| WebSocket `send()` drops silently when not OPEN | `websocket.ts:462-466` | Orders lost without notification |
| Missing `case 10` for MarketFundingUpdate | `websocket.ts:358-404` | Funding events dropped silently |
| MCP server zero authentication | `mcp/index.ts:48-76` | Any local process can execute trades |

---

## Overview

Build a fully automated carry trade strategy into PerplBot that captures yield from positive funding rates on Perpl's BTC perpetual market. The bot holds a **long WBTC spot position on Uniswap V3 (Monad)** and a matching **short BTC perpetual on Perpl**, creating a delta-neutral portfolio that earns funding payments.

**Target**: >$500k capital, >5% APY from funding, fully automated on Monad mainnet.

---

## Problem Statement / Motivation

Perpl's BTC perpetual market has funding rates that historically average 5-10% annualized in neutral markets and 15-25% in bull markets. Only ~16-17% of days have negative funding. This creates a structural yield opportunity for market-neutral strategies.

PerplBot already has:
- Full Perpl SDK (contracts, API, WebSocket, wallet)
- Trading strategies (grid, market making)
- Simulation framework (dry-run, liquidation analysis)
- Multiple UIs (CLI, Telegram, chatbot, MCP)

What's missing:
- Uniswap integration (spot leg)
- Carry trade strategy (two-leg orchestration)
- State persistence for long-running strategies
- Funding rate monitor with historical tracking

---

## Proposed Solution

Implement the carry bot as an **integrated strategy module** with these new files:

```
src/sdk/
  integrations/
    uniswap.ts              # Uniswap V3 swap, quote (4 methods, hardcoded path)
    uniswap-abi.ts          # SwapRouter02, QuoterV2, ERC20 ABIs
  trading/
    strategies/
      carry.ts              # Carry strategy (state machine + inline TWAP + funding checks)
      carry-state.ts        # Persistent state (SQLite, single table)
src/cli/
    carry.ts                # CLI commands (start, stop, status)
```

### Research Insights: Scope Reduction

**Per simplicity review, v1 scope is 5 files, ~780 LOC** (down from 12+ files, ~1500 LOC):

- **Killed**: Phase 4 (Telegram/MCP alerts), Phase 5 (simulation/backtest)
- **Inlined**: TWAP executor (~30 line function, not a class), FundingMonitor (call `portfolio.getFundingInfo()` directly)
- **Simplified**: CarryConfig from 25 to 8 fields (rest are named constants), UniswapClient to 4 methods
- **Dropped**: `carry_events` table (use structured logs), EventEmitter (use logging), `carry history/config/simulate` CLI commands

---

## Technical Approach

### Architecture

```
                     ┌─────────────────────┐
                     │   CarryStrategy      │
                     │   (State Machine)    │
                     │                      │
                     │  IDLE → ENTERING →   │
                     │  ACTIVE → EXITING →  │
                     │  IDLE                │
                     └──────────┬──────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
     ┌────────▼────────┐ ┌─────▼──────┐ ┌────────▼────────┐
     │   Perp Leg       │ │  Spot Leg   │ │  Risk Checks    │
     │  (Perpl SDK)     │ │ (Uniswap)   │ │                 │
     │  - Short BTC     │ │ - Buy WBTC  │ │ - Delta monitor │
     │  - Margin mgmt   │ │ - TWAP exec │ │ - Liq distance  │
     │  - Funding track │ │ - Routing   │ │ - Drawdown      │
     └────────┬────────┘ └─────┬──────┘ │ - Reserve fund  │
              │                │         └────────┬────────┘
              │                │                   │
     ┌────────▼────────────────▼───────────────────▼────────┐
     │                   Shared Layer                        │
     │  Wallet | State Persistence | ExchangeStateTracker    │
     └──────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Sequential execution (perp first, spot second)** — Industry standard per Talos research. Perp is less liquid, so execute first to avoid adverse selection. If spot leg fails, immediately unwind perp with 60s timeout.

2. **State machine architecture** — Unlike grid/MM strategies (stateless order generators), the carry bot is a long-running process with phases: `IDLE → ENTERING → ACTIVE → EXITING → IDLE`. State persists to SQLite and reconciles with on-chain data on restart.

3. **Interleaved TWAP for entry/exit** — Instead of completing all perp chunks then all spot chunks (peak unhedged exposure = $500k), alternate: perp chunk 1 → spot chunk 1 → perp chunk 2 → spot chunk 2. **Reduces peak unhedged exposure from $500k to ~$50k (one chunk).**

4. **Uniswap V3 via SwapRouter02** — Use SwapRouter02 (`0xfe31...b900`) and QuoterV2 (`0x661e...b08d`) on Monad via viem. **Not UniversalRouter** (adds Permit2 complexity for no benefit). **Not `@uniswap/v3-sdk`** (ethers.js dependency). Direct viem contract calls with `simulateContract` → `writeContract` pattern.

5. **Funding rate from on-chain** — Reuse existing `portfolio.getFundingInfo()` directly. No separate FundingMonitor class needed for v1.

6. **Mandatory tx receipt verification** — Every write operation must call `waitForTransactionReceipt` and verify `status === 'success'` before proceeding. This is the single most critical gap in the current codebase.

### Research Insights: Uniswap V3 Integration

**From Uniswap research agent:**

- **SwapRouter02 vs UniversalRouter**: SwapRouter02 is simpler (standard ABI), still works (immutable contract), no Permit2 required. UniversalRouter adds command-byte encoding complexity for V4/NFT features we don't need.
- **Permit2**: Skip it. Standard `approve(maxUint256)` to SwapRouter02 is fine for server-side bot. Permit2 solves UX for end users, not bots.
- **Path encoding**: Use `viem.encodePacked(['address','uint24','address'], [tokenIn, fee, tokenOut])` for single-hop, extend for multi-hop through WMON.
- **QuoterV2 calls**: Use `simulateContract` (it's a state-modifying function called via `eth_call`). Fall back to raw `publicClient.call()` if RPC is strict.
- **Fee tiers**: Check all 4 (100, 500, 3000, 10000) in parallel, pick best output. WBTC pairs likely 500 or 3000 bps.

---

### Implementation Phases

#### Phase 1: Foundation + Core Strategy (merged)

Build the Uniswap client and carry strategy together since they're tightly coupled.

##### 1.1 Uniswap V3 Integration

**File**: `src/sdk/integrations/uniswap.ts` (~120 lines)

```typescript
interface UniswapConfig {
  factoryAddress: Address;
  swapRouterAddress: Address;
  quoterAddress: Address;
  wmonAddress: Address;
  defaultDeadlineSeconds: number;  // REQUIRED, not optional
}

interface SwapResult {
  txHash: Hash;
  amountIn: bigint;
  amountOut: bigint;
  gasUsed: bigint;
}

class UniswapClient {
  constructor(publicClient, walletClient, config: UniswapConfig)

  // 4 methods only — hardcoded token path after pool research
  getQuote(amountIn: bigint): Promise<bigint>
  swap(amountIn: bigint, minAmountOut: bigint): Promise<SwapResult>
  reverseSwap(amountIn: bigint, minAmountOut: bigint): Promise<SwapResult>  // WBTC → AUSD
  approve(amount: bigint): Promise<Hash>
}
```

**Research insights applied:**
- `deadline` is NOT optional — hardcode `block.timestamp + 120` (MEV protection)
- Recipient hardcoded to `wallet.address` inside `swap()` (cannot be caller-controlled)
- Use `simulateContract` → `writeContract` pattern (catches reverts before wasting gas)
- One-time `approve(maxUint256)` at startup, not per-swap
- Post-swap balance check: verify WBTC balance increased by ~amountOut
- Route determined at dev time (direct or via WMON), not dynamic routing

**Contract addresses (Monad mainnet)**:

| Contract | Address | Notes |
|----------|---------|-------|
| SwapRouter02 | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` | NOT UniversalRouter |
| QuoterV2 | `0x661e93cca42afacb172121ef892830ca3b70f08d` | Called via eth_call |
| UniswapV3Factory | `0x204faca1764b154221e35c0d20abb3c525710498` | Pool discovery |
| WBTC | `0x0555e30da8f98308edb960aa94c0db47230d2b9c` | 8 decimals |
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | 6 decimals |
| WMON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | For routing fallback |

**ABIs needed**: `src/sdk/integrations/uniswap-abi.ts` (~80 lines)
- SwapRouter02: `exactInputSingle`, `exactInput`
- QuoterV2: `quoteExactInputSingle`, `quoteExactInput`
- ERC20: `approve`, `allowance`, `balanceOf`

**Test plan** (`test/integrations/uniswap.test.ts`):
- Quote accuracy (mock pool state)
- Slippage protection (amountOutMinimum enforced at contract level)
- Approval handling (approve once, check allowance)
- Deadline enforcement (never optional)
- Recipient always self

##### 1.2 Carry State Persistence

**File**: `src/sdk/trading/strategies/carry-state.ts` (~60 lines)

**Separate database file** (`./data/carry.db`), not shared with Telegram bot user DB.

```sql
-- Financial values stored as TEXT (bigint strings), NOT REAL
-- Avoids IEEE 754 floating-point drift on cumulative operations
CREATE TABLE carry_state (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'idle'
    CHECK (phase IN ('idle', 'entering', 'active', 'exiting')),
  updated_at INTEGER NOT NULL,  -- Unix ms, not text

  -- Leg completion tracking (critical for crash recovery)
  perp_leg_complete INTEGER NOT NULL DEFAULT 0,  -- boolean
  spot_leg_complete INTEGER NOT NULL DEFAULT 0,  -- boolean

  -- Position (TEXT for precision, nullable for idle)
  perp_entry_price_pns TEXT,
  perp_size_lns TEXT,
  perp_margin_cns TEXT,
  spot_entry_price TEXT,
  spot_size TEXT,

  -- Running totals (TEXT to prevent float accumulation drift)
  funding_earned_cns TEXT NOT NULL DEFAULT '0',
  costs_cns TEXT NOT NULL DEFAULT '0',
  initial_capital_cns TEXT,

  -- Last tx hash for reconciliation
  last_tx_hash TEXT,

  -- Phase-dependent NOT NULL constraints
  CHECK (phase = 'idle' OR perp_entry_price_pns IS NOT NULL OR perp_leg_complete = 0)
);

-- Only one non-idle position allowed at a time
CREATE UNIQUE INDEX idx_carry_active
  ON carry_state(phase) WHERE phase != 'idle';

PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

**Key operations** (3 functions only for v1):
- `saveState(state)` / `loadState()` / `markClosed(id, finalPnl)`
- All wrapped in `db.transaction()` for atomicity

**Research insights applied:**
- TEXT columns with `_pns`, `_cns`, `_lns` suffixes (matches on-chain fixed-point scale)
- `perp_leg_complete` / `spot_leg_complete` booleans for crash recovery during entry
- `last_tx_hash` for reconciliation verification
- `PRAGMA synchronous = FULL` for crash consistency
- Partial unique index prevents double-active positions
- Schema versioning via `PRAGMA user_version`

##### 1.3 Carry Strategy (State Machine)

**File**: `src/sdk/trading/strategies/carry.ts` (~400 lines)

```typescript
// Essential config only (8 fields, rest are named constants)
interface CarryConfig {
  perpId: bigint;
  spotTokenIn: Address;         // AUSD
  spotTokenOut: Address;        // WBTC
  totalCapitalAusd: number;
  perpLeverage: number;
  minFundingRateApy: number;    // Entry threshold (e.g. 0.05 = 5%)
  exitFundingRateApy: number;   // Exit threshold (e.g. 0.01 = 1%)
  databasePath: string;
}

// Hardcoded constants (tunable later by promoting to config)
const DEFAULTS = {
  RESERVE_PCT: 0.20,
  MAX_DELTA_DRIFT: 0.02,
  LIQ_BUFFER: 2.0,
  MAX_DRAWDOWN: 0.05,
  TWAP_CHUNK_USD: 50_000,
  TWAP_INTERVAL_MS: 300_000,
  SPOT_SLIPPAGE_BPS: 50,
  PERP_SLIPPAGE_BPS: 30,
  LEG_FAILURE_TIMEOUT_MS: 60_000,
  FUNDING_CHECK_MS: 300_000,
  REBALANCE_CHECK_MS: 60_000,
  CONFIRMATION_PERIODS: 3,
  RE_ENTRY_COOLDOWN_MS: 4 * 3600 * 1000,
  MIN_MON_WEI: 1_000_000_000_000_000_000n, // 1 MON
} as const;

const CARRY_PHASES = ['idle', 'entering', 'active', 'exiting'] as const;
type CarryPhase = (typeof CARRY_PHASES)[number];

// Error hierarchy for programmatic recovery decisions
class CarryError extends Error {
  constructor(
    message: string,
    public readonly code: CarryErrorCode,
    public readonly recoverable: boolean,
    public readonly cause?: Error
  ) { super(message); this.name = 'CarryError'; }
}

type CarryErrorCode =
  | 'ENTRY_PERP_FAILED'
  | 'ENTRY_SPOT_FAILED_AFTER_PERP'  // Critical: needs unwind
  | 'EXIT_FAILED'
  | 'TWAP_PRICE_DEVIATION'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'INSUFFICIENT_BALANCE'
  | 'STATE_RECONCILIATION_FAILED'
  | 'REBALANCE_FAILED';

class CarryStrategy {
  constructor(
    config: CarryConfig,
    exchange: Exchange,
    uniswap: UniswapClient,
    wallet: Wallet,
    stateStore: CarryStateStore,
    portfolio: Portfolio       // Reuse existing for funding rate
  )

  async start(): Promise<void>   // Begin monitoring loop, register SIGINT/SIGTERM
  async stop(): Promise<void>    // Unwind at market (no separate forceStop for v1)

  getMetrics(): Promise<CarryMetrics>  // For CLI status
}
```

**State machine with leg tracking:**

```
IDLE
  ├── funding rate > threshold for N periods → ENTERING (perp_leg_complete=false, spot_leg_complete=false)
  └── stop() called → (no-op)

ENTERING
  ├── perp leg filled → update perp_leg_complete=true → execute spot leg
  ├── both legs filled → ACTIVE
  ├── perp leg fails → IDLE (nothing to unwind)
  ├── spot leg fails (perp filled) → unwind perp → IDLE
  ├── timeout (legFailureTimeoutMs after perp completes) → unwind perp → IDLE
  └── stop() called → unwind completed leg → IDLE

ACTIVE
  ├── funding rate < exit threshold → EXITING
  ├── drawdown exceeded → EXITING (emergency)
  ├── delta drift > threshold → rebalance (stay ACTIVE)
  ├── margin low → top up from reserve (stay ACTIVE)
  └── stop() called → EXITING

EXITING
  ├── both legs closed → IDLE
  ├── one leg fails → retry with backoff (track exitAttempts, exitStartedAt)
  └── after N retries → CRITICAL alert, require manual intervention
```

**Inline TWAP execution** (~30 lines, not a separate class):

```typescript
async function executeInChunks(
  totalAmount: bigint,
  chunkSize: bigint,
  intervalMs: number,
  executeFn: (chunk: bigint) => Promise<{ amountOut: bigint; txHash: Hash }>,
  verifyFn: () => Promise<boolean>,  // Verify on-chain state after each chunk
  getCurrentPrice: () => Promise<number>,
  startPrice: number,
  maxDeviationBps: number,
): Promise<{ totalOut: bigint; chunksExecuted: number; aborted: boolean }>
```

**Critical: Every trade must verify receipt:**

```typescript
async function executeAndVerify(
  operation: () => Promise<Hash>,
  publicClient: PublicClient
): Promise<TransactionReceipt> {
  const hash = await operation();
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    throw new CarryError(`Transaction reverted: ${hash}`, 'ENTRY_PERP_FAILED', false);
  }
  return receipt;
}
```

**Interleaved TWAP entry:**
```
For chunk 1..N:
  1. Execute perp chunk (short)
  2. Wait for receipt, verify position on-chain
  3. Execute spot chunk (buy WBTC)
  4. Wait for receipt, verify WBTC balance
  5. Sleep intervalMs
  6. Check price deviation from start
```

**Safety checks before every operation:**
- `exchange.isHalted()` — abort if exchange halted
- `perpInfo.markPriceValid` — abort if oracle stale
- Cross-reference Perpl mark price vs Uniswap quote (>1% divergence = anomalous)
- WBTC/BTC depeg check (Uniswap WBTC price vs Perpl BTC oracle)

**Inline funding rate check** (no separate FundingMonitor):
```typescript
const fundingInfo = await portfolio.getFundingInfo(config.perpId);
const annualizedRate = annualizeFundingRate(fundingInfo.currentRate, fundingIntervalBlocks);
```

**On-chain reconciliation matrix** (on startup):

| DB Phase | On-chain Perp | On-chain WBTC | Action |
|----------|---------------|---------------|--------|
| idle | None | None | Normal start |
| idle | Exists | Exists | ALERT: orphaned position, refuse to start |
| entering (perp=true, spot=false) | Exists | None | Unwind perp, transition to idle |
| entering (perp=false) | None | None | Transition to idle (nothing happened) |
| active | Exists | Exists | Resume normal operation, recalculate metrics |
| active | None | Exists | ALERT: perp liquidated, sell WBTC, mark closed |
| active | Exists | None | ALERT: WBTC missing, operator intervention |
| exiting | Partial | Partial | Continue exit from where left off |

**Test plan** (`test/trading/strategies/carry.test.ts`):
- State machine transitions (all edges including crash recovery)
- Entry: interleaved TWAP happy path, partial fill handling, spot leg failure → perp unwind
- Exit: normal, emergency (drawdown), stop command
- Rebalancing: delta drift detection and correction
- Reconciliation: all 8 matrix cases above
- Receipt verification: reverted tx detection
- Funding rate threshold with confirmation count

---

#### Phase 2: CLI Integration

**File**: `src/cli/carry.ts` (~120 lines)

```
perplbot carry start [--config <path>]  # Start carry bot (blocks, handles SIGINT)
perplbot carry stop                     # Signal stop to running instance
perplbot carry status                   # Current metrics (read-only DB access)
```

**Register in** `src/cli/index.ts` alongside existing `trade`, `manage`, `simulate` commands.

**Process lifecycle:**
- `carry start` blocks in foreground, runs the strategy loop
- Registers SIGINT/SIGTERM handlers that trigger `strategy.stop()`
- Graceful shutdown: unwind positions via market orders, persist final state, exit
- `carry status` opens DB in read-only mode, also queries on-chain state for live metrics

**Status output example**:

```
Carry Bot Status
────────────────────────────────────────
Phase:              ACTIVE (running 3d 14h)
BTC Funding Rate:   8.2% APY (0.00094% per 8h)
Delta Exposure:     0.8% ($1,980 imbalanced)

Perp Leg:
  Side:             Short
  Size:             2.85 BTC @ $87,420 avg entry
  Margin:           $124,500 (2.4x maintenance buffer)
  Liq Distance:     38.2% ($33,400 above current price)

Spot Leg:
  WBTC Held:        2.84 BTC
  Cost Basis:       $248,700
  Current Value:    $248,200

PnL Breakdown:
  Funding Earned:   +$2,847 (+1.14%)
  Spot PnL:         -$500 (-0.20%)
  Perp PnL:         +$520 (+0.21%)
  Costs:            -$380 (entry: $290, rebalance: $62, gas: $28)
  Net PnL:          +$2,487 (+1.00%)
  Net APY:          10.2%

Reserve:            $49,800 (20.0% of capital)
────────────────────────────────────────
```

---

#### Phase 3: Polish & Hardening

- Config-from-file support (TOML or JSON)
- Crash recovery integration testing (kill -9 during various phases)
- Nonce manager for transaction serialization
- Gas escalation for stuck transactions during exit

---

## Deferred to Post-v1

| Feature | Rationale |
|---------|-----------|
| Telegram alerts (`/carry_status`, `/carry_stop`) | Single operator has CLI access. Add when chatbot warrants it |
| MCP tools (`carry_status`, `carry_start`, `carry_stop`) | 5-minute addition later since it calls same functions as CLI |
| Simulation/backtest (`carry simulate`) | No historical data exists yet; test with small capital instead |
| Dynamic Uniswap routing (`findBestRoute`) | Pool topology is static; hardcode known path |
| `carry_events` audit table | Use structured log files; add DB events when event volume warrants |
| EventEmitter on CarryStrategy | No subscribers in v1; use structured logging |
| `carry history` / `carry config` CLI commands | Logs provide history; operator wrote the config |
| DelegatedAccount key separation | **MUST implement before mainnet $500k deployment** (see Security) |
| DEX aggregator routing (0x, Monorail) | Start with direct Uniswap V3; add aggregator later |
| Multi-asset carry (ETH, SOL) | Extend after BTC proves profitable |

---

## Pre-Implementation Codebase Fixes (Blocking)

These must be fixed before the carry bot can safely operate:

### 1. Add Transaction Receipt Verification

Add a helper to `Exchange.ts` or a shared utility:

```typescript
async function execOrderAndVerify(exchange, orderDesc, publicClient): Promise<TransactionReceipt> {
  const hash = await exchange.execOrder(orderDesc);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`Tx reverted: ${hash}`);
  return receipt;
}
```

### 2. Fix Empty Catch Blocks in wallet.ts

Replace 6 `catch { }` blocks with logging:

```typescript
} catch (wsError) {
  console.warn('[wallet] WebSocket submit failed, falling back to RPC:', (wsError as Error).message);
}
```

### 3. Add WebSocket Funding Handler

In `websocket.ts` `handleMessage()`, add:

```typescript
case 10: // MarketFundingUpdate
  this.emit("funding-update", (msg as any).d);
  break;
```

This eliminates 288 unnecessary RPC calls/day and enables sub-second funding rate detection.

### 4. Add MCP Authentication (if MCP server is running)

Bearer token from env var, checked on every POST. Bind to `127.0.0.1` only.

---

## Acceptance Criteria

### Functional Requirements

- [x] Bot monitors BTC funding rate and enters carry when rate > 5% APY for 3 consecutive periods
- [x] Entry uses interleaved TWAP (perp chunk → spot chunk alternating, $50k chunks)
- [x] Every trade verifies tx receipt before proceeding to next step
- [x] Bot maintains delta neutrality by rebalancing when drift > 2%
- [x] Bot exits when funding < 1% APY, drawdown > 5%, or manual stop
- [x] State persists to SQLite (TEXT for financials, WAL mode, FULL sync)
- [x] Crash recovery reconciles DB state against on-chain positions using state matrix
- [x] Entry failure on spot leg triggers automatic perp unwind

### Non-Functional Requirements

- [x] Handles >$500k capital deployment safely
- [x] Interleaved TWAP keeps peak unhedged exposure < $50k (one chunk)
- [x] Swap deadline always set (block.timestamp + 120s, never optional)
- [x] Swap recipient hardcoded to self (not caller-configurable)
- [x] `isHalted()` and `markPriceValid` checked before every trade
- [x] All trades and state changes logged with structured logging

### Quality Gates

- [x] Unit tests for: carry state machine, TWAP chunking, Uniswap client, state persistence, reconciliation
- [ ] Integration test: full entry/exit cycle on Monad testnet
- [x] Config validation passes (8 fields)
- [x] `npm run typecheck` passes
- [x] `npm test` passes

---

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Net APY from carry | >5% annualized | `carry status` net APY field |
| Delta exposure | <2% during active carry | Rebalance frequency and peak drift |
| Uptime | >99% (bot running, monitoring) | Process monitoring |
| Entry/exit slippage | <0.5% combined | Cost breakdown in status |
| Peak unhedged exposure | <$50k (one TWAP chunk) | Interleaved execution |
| Crash recovery time | <60 seconds to reconcile and resume | Measured from restart |

---

## Dependencies & Prerequisites

### Hard Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| PerplBot SDK (wallet, contracts, API) | Exists | `src/sdk/` |
| Monad mainnet RPC | Live | `https://rpc.monad.xyz` |
| Perpl mainnet exchange | Live | Per config.ts |
| Uniswap V3 on Monad | Live | Addresses confirmed |
| WBTC on Monad | Live | `0x0555e30d...` |
| AUSD on Monad | Live | `0x00000000eF...` |
| **Codebase fixes (see above)** | **TODO** | **Blocking** |

### Research Items (Resolve During Phase 1)

| Item | Risk | Resolution |
|------|------|-----------|
| BTC perp ID on mainnet | Medium | Query `getPerpetualInfo()` |
| AUSD/WBTC pool existence | Medium | Query factory for pool; determines direct vs WMON routing |
| AUSD/WBTC pool liquidity depth | High | If <$2.5M TVL, use smaller chunks or aggregator |
| AUSD ERC20 implementation | Medium | Verify no non-standard approval behavior (check proxy on MonadScan) |
| Perpl withdrawal timelock | Medium | Test `decreasePositionCollateral` on testnet |

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Spot leg fails after perp entry | Medium | High | Auto-unwind perp; interleaved TWAP limits exposure to 1 chunk |
| Tx reverts silently (current codebase) | **High** | **Critical** | **Must fix: add receipt verification** |
| Funding rate goes deeply negative | Medium | Medium | Exit threshold + drawdown limit |
| Uniswap pool too shallow | Medium | High | Pre-entry liquidity check; smaller TWAP chunks |
| Bot crashes during active position | Low | Medium | State persistence + reconciliation matrix |
| WBTC depegs from BTC | Very Low | High | Monitor via Uniswap vs Perpl oracle divergence; exit at 0.5% depeg |
| Monad chain congestion | Low | Medium | Receipt timeout + gas escalation; longer exit timeout |
| Perpl exchange halted | Very Low | High | Check `isHalted()` before every trade; alert on halt |
| Nonce collision from concurrent txs | Medium | Medium | Sequential execution in main loop; nonce manager in Phase 3 |
| Oracle staleness | Low | High | Check `markPriceValid`; cross-reference vs Uniswap price |

---

## Future Considerations

1. **DelegatedAccount pattern**: MUST implement before mainnet $500k (operator/owner key separation)
2. **DEX aggregator routing**: Add 0x or Monorail for better spot execution
3. **Multi-asset carry**: Extend to ETH, SOL perpetuals
4. **EventEmitter + Telegram alerts**: When monitoring needs exceed CLI
5. **Simulation/backtest**: When historical data is available
6. **Atomic execution contract**: Deploy multicall for same-tx entry/exit
7. **Permit2 migration**: Only if switching to UniversalRouter

---

## References & Research

### Internal References

- Brainstorm: `docs/brainstorms/2026-03-07-carry-bot-brainstorm.md`
- Grid strategy pattern: `src/sdk/trading/strategies/grid.ts`
- Order builder: `src/sdk/trading/orders.ts`
- Funding rate access: `src/sdk/trading/portfolio.ts:390-415`
- State tracker: `src/sdk/state/exchange.ts`
- Existing DB patterns: `src/bot/db/index.ts`, `src/bot/db/schema.ts`
- WebSocket client: `src/sdk/api/websocket.ts`

### External References

- [Uniswap V3 Monad Deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/monad-deployments)
- [Uniswap V3 Single Swaps Guide](https://docs.uniswap.org/contracts/v3/guides/swaps/single-swaps)
- [Uniswap SwapRouter02 (GitHub)](https://github.com/Uniswap/swap-router-contracts)
- [viem simulateContract](https://viem.sh/docs/contract/simulateContract)
- [viem encodePacked](https://viem.sh/docs/abi/encodePacked)
- [Ethena Delta-Neutral Strategy](https://docs.ethena.fi/solution-overview/usde-overview/delta-neutral-examples)
- [Talos Multi-Leg Algo Execution](https://www.talos.com/insights/how-talos-multi-leg-algos-slash-execution-slippage-for-basis-trades)
