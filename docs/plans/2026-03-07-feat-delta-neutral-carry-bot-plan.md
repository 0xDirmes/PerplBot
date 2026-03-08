---
title: "feat: Delta-Neutral Funding Rate Carry Bot (AUSD/BTC)"
type: feat
status: active
date: 2026-03-07
brainstorm: docs/brainstorms/2026-03-07-carry-bot-brainstorm.md
---

# Delta-Neutral Funding Rate Carry Bot (AUSD/BTC)

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
- TWAP execution engine
- State persistence for long-running strategies
- Funding rate monitor with historical tracking

---

## Proposed Solution

Implement the carry bot as an **integrated strategy module** (Approach A from brainstorm) with these new components:

```
src/sdk/
  integrations/
    uniswap.ts              # Uniswap V3 swap, quote, routing
    uniswap-abi.ts          # SwapRouter, QuoterV2, ERC20 ABIs
  trading/
    twap.ts                 # TWAP execution engine (both legs)
    funding.ts              # Funding rate monitor + annualization
    strategies/
      carry.ts              # Carry strategy (4-phase state machine)
      carry-state.ts        # Persistent state (SQLite)
      carry-config.ts       # CarryConfig interface + validation
  simulation/
    carry-sim.ts            # Carry strategy backtest/simulation
src/cli/
    carry.ts                # CLI commands (start, stop, status, history)
```

---

## Technical Approach

### Architecture

```
                     ┌─────────────────────┐
                     │   CarryStrategy      │
                     │   (State Machine)    │
                     │                     │
                     │  IDLE → ENTERING →  │
                     │  ACTIVE → EXITING → │
                     │  IDLE               │
                     └──────────┬──────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
     ┌────────▼────────┐ ┌─────▼──────┐ ┌────────▼────────┐
     │   Perp Leg       │ │  Spot Leg   │ │  Risk Manager   │
     │  (Perpl SDK)     │ │ (Uniswap)   │ │                 │
     │  - Short BTC     │ │ - Buy WBTC  │ │ - Delta monitor │
     │  - Margin mgmt   │ │ - TWAP exec │ │ - Liq distance  │
     │  - Funding track │ │ - Routing   │ │ - Drawdown      │
     └────────┬────────┘ └─────┬──────┘ │ - Reserve fund  │
              │                │         └────────┬────────┘
              │                │                   │
     ┌────────▼────────────────▼───────────────────▼────────┐
     │                   Shared Layer                        │
     │  Wallet | TWAP Engine | State Persistence | Alerts   │
     └──────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Sequential execution (perp first, spot second)** — Industry standard per Talos research. Perp is less liquid, so execute first to avoid adverse selection. If spot leg fails, immediately unwind perp with 60s timeout.

2. **State machine architecture** — Unlike grid/MM strategies (stateless order generators), the carry bot is a long-running process with phases: `IDLE → ENTERING → ACTIVE → EXITING → IDLE`. State persists to SQLite and reconciles with on-chain data on restart.

3. **TWAP for large orders** — Split orders into $50k chunks with 5-minute intervals. Both legs use the same TWAP engine. Abort remaining chunks if price moves >2% from start.

4. **Uniswap V3 direct integration** — Use SwapRouter02 (`0xfe31...b900`) and QuoterV2 (`0x661e...b08d`) on Monad via viem. Route through WMON if no direct AUSD/WBTC pool exists.

5. **Funding rate from on-chain data** — Use `Exchange.getFundingInterval()` + `perpetualInfo.fundingRatePct100k` for authoritative rate. Annualize with simple multiplication: `rate_per_period * periods_per_year`.

### Implementation Phases

#### Phase 1: Foundation (Prerequisites)

Build the SDK-level components that the carry strategy depends on. These are general-purpose modules usable by other strategies too.

##### 1.1 Uniswap V3 Integration

**File**: `src/sdk/integrations/uniswap.ts`

New module providing:

```typescript
// Key interfaces
interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxSlippageBps: number;
  recipient: Address;
  deadline?: bigint;
}

interface SwapQuote {
  amountOut: bigint;
  priceImpactBps: number;
  route: Address[];       // token path
  feeTier: number;
  gasEstimate: bigint;
}

// Key functions
class UniswapClient {
  constructor(publicClient, walletClient, config: UniswapConfig)

  // Quotes (read-only, no gas)
  getQuote(params: QuoteParams): Promise<SwapQuote>
  getSpotPrice(tokenA: Address, tokenB: Address): Promise<number>
  getPoolLiquidity(tokenA: Address, tokenB: Address, feeTier: number): Promise<bigint>

  // Execution
  swap(params: SwapParams): Promise<SwapResult>
  approve(token: Address, amount: bigint): Promise<Hash>

  // Routing
  findBestRoute(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route>
}
```

**Contract addresses (Monad mainnet)**:

| Contract | Address | Source |
|----------|---------|--------|
| UniswapV3Factory | `0x204faca1764b154221e35c0d20abb3c525710498` | Uniswap docs |
| SwapRouter02 | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` | Uniswap docs |
| QuoterV2 | `0x661e93cca42afacb172121ef892830ca3b70f08d` | Uniswap docs |
| UniversalRouter | `0x0d97dc33264bfc1c226207428a79b26757fb9dc3` | Uniswap docs |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Uniswap docs |
| WBTC | `0x0555e30da8f98308edb960aa94c0db47230d2b9c` | MonadScan |
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | Perpl config |
| WMON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | Monad docs |

**ABIs needed**: `src/sdk/integrations/uniswap-abi.ts`
- SwapRouter02: `exactInputSingle`, `exactInput` (multi-hop)
- QuoterV2: `quoteExactInputSingle`, `quoteExactInput`
- ERC20: `approve`, `allowance`, `balanceOf`, `decimals`
- UniswapV3Factory: `getPool`
- UniswapV3Pool: `slot0`, `liquidity`

**Routing logic**:
1. Check if direct AUSD/WBTC pool exists (any fee tier: 100, 500, 3000, 10000)
2. If yes, use `exactInputSingle`
3. If no, route through WMON: AUSD → WMON → WBTC using `exactInput` (multi-hop path)
4. Select fee tier with best quote

**Test plan** (`test/integrations/uniswap.test.ts`):
- Quote accuracy (mock pool state)
- Multi-hop routing when no direct pool
- Slippage protection (revert if exceeded)
- Approval handling (approve once, check allowance)
- Error handling (pool not found, insufficient liquidity)

##### 1.2 TWAP Execution Engine

**File**: `src/sdk/trading/twap.ts`

```typescript
interface TwapConfig {
  totalAmount: bigint;
  chunkSize: bigint;           // Default: $50k equivalent
  intervalMs: number;           // Default: 5 minutes (300_000)
  maxSlippageBps: number;       // Per-chunk slippage limit
  maxPriceDeviationBps: number; // Abort if price moves >200bps from start
  maxDurationMs: number;        // Hard timeout (default: 60 minutes)
}

interface TwapResult {
  chunksExecuted: number;
  chunksTotal: number;
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  averagePrice: number;
  totalGasCost: bigint;
  aborted: boolean;
  abortReason?: string;
}

class TwapExecutor {
  constructor(config: TwapConfig)

  // Execute TWAP with progress callbacks
  execute(
    executeFn: (chunkAmount: bigint) => Promise<ChunkResult>,
    getCurrentPrice: () => Promise<number>,
    onProgress?: (chunk: number, total: number, result: ChunkResult) => void
  ): Promise<TwapResult>

  // Abort a running TWAP
  abort(reason: string): void
}
```

**Abort conditions**:
- Price deviation exceeds `maxPriceDeviationBps` from starting price
- Total duration exceeds `maxDurationMs`
- Individual chunk fails (configurable: skip vs abort)
- External abort signal (e.g., risk manager triggers exit)

**Test plan** (`test/trading/twap.test.ts`):
- Happy path: all chunks execute
- Price deviation abort
- Chunk failure handling
- External abort signal
- Partial execution PnL calculation

##### 1.3 Funding Rate Monitor

**File**: `src/sdk/trading/funding.ts`

```typescript
interface FundingSnapshot {
  perpId: bigint;
  timestamp: number;
  ratePerPeriod: number;        // Raw rate from contract (per 100k)
  annualizedRate: number;       // Annualized APY
  fundingIntervalBlocks: bigint;
  longOI: number;
  shortOI: number;
}

class FundingMonitor extends EventEmitter {
  constructor(exchange: Exchange, perpId: bigint, pollIntervalMs: number)

  start(): void
  stop(): void

  // Data access
  getCurrentRate(): FundingSnapshot | null
  getAnnualizedRate(): number
  getHistory(count: number): FundingSnapshot[]
  getAverageRate(periodMs: number): number  // Average over last N ms

  // Events emitted:
  // "rate-update" (snapshot: FundingSnapshot)
  // "threshold-crossed" (direction: "above" | "below", rate: number)
}
```

**Annualization formula**:
```
fundingInterval = Exchange.getFundingInterval()  // blocks
blockTime = estimate from recent blocks (~500ms on Monad)
periodsPerYear = (365.25 * 24 * 3600) / (fundingInterval * blockTime)
annualizedRate = ratePerPeriod * periodsPerYear
```

**Test plan** (`test/trading/funding.test.ts`):
- Annualization math correctness
- Polling lifecycle (start/stop)
- Threshold crossing detection
- History tracking
- Edge case: zero funding rate

##### 1.4 Carry State Persistence

**File**: `src/sdk/trading/strategies/carry-state.ts`

Extend existing SQLite schema (`src/bot/db/schema.ts`) or use a dedicated file:

```sql
CREATE TABLE IF NOT EXISTS carry_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  perp_id INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idle',  -- idle, entering, active, exiting
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Perp leg
  perp_entry_price REAL,
  perp_size REAL,
  perp_leverage REAL,
  perp_margin_deposited REAL,

  -- Spot leg
  spot_entry_price REAL,
  spot_size REAL,                 -- WBTC amount
  spot_cost_basis REAL,           -- Total AUSD spent

  -- Tracking
  cumulative_funding_earned REAL DEFAULT 0,
  cumulative_rebalance_cost REAL DEFAULT 0,
  cumulative_gas_cost REAL DEFAULT 0,
  total_entry_cost REAL DEFAULT 0,  -- Slippage + fees on entry
  initial_capital REAL,

  -- Config snapshot (at time of entry)
  config_json TEXT
);

CREATE TABLE IF NOT EXISTS carry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES carry_positions(id),
  event_type TEXT NOT NULL,  -- entry, exit, rebalance, funding, margin_topup, alert
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  details_json TEXT,
  FOREIGN KEY (position_id) REFERENCES carry_positions(id)
);
```

**Key operations**:
- `savePosition(position)` / `loadActivePosition()` / `markClosed(id, finalPnl)`
- `logEvent(positionId, type, details)`
- `getEventHistory(positionId, type?, limit?)`
- `reconcileWithOnChain(onChainPosition, onChainWbtcBalance)`

**Test plan** (`test/trading/strategies/carry-state.test.ts`):
- CRUD operations
- State transitions (idle → entering → active → exiting → idle)
- Crash recovery: load state, reconcile with on-chain
- Event logging and retrieval

---

#### Phase 2: Core Strategy

Build the carry strategy state machine that orchestrates both legs.

##### 2.1 Carry Config

**File**: `src/sdk/trading/strategies/carry-config.ts`

```typescript
export interface CarryConfig {
  // Market
  perpId: bigint;                    // BTC perp ID on mainnet
  spotTokenIn: Address;              // AUSD address
  spotTokenOut: Address;             // WBTC address

  // Entry/exit thresholds
  minFundingRateApy: number;         // Min annualized rate to enter (default: 0.05 = 5%)
  exitFundingRateApy: number;        // Rate below which to exit (default: 0.01 = 1%)
  entryConfirmationPeriods: number;  // Require rate above threshold for N periods (default: 3)
  reEntryCooldownMs: number;         // Min time between exit and re-entry (default: 4h)

  // Position sizing
  totalCapitalAusd: number;          // Total AUSD available
  perpLeverage: number;              // Perp leverage (default: 2)
  capitalReservePct: number;         // Reserve ratio (default: 0.20)

  // Risk management
  maxDeltaExposurePct: number;       // Rebalance trigger (default: 0.02 = 2%)
  liquidationBufferMultiple: number; // Margin above maintenance (default: 2.0)
  maxDrawdownPct: number;            // Auto-exit drawdown (default: 0.05 = 5%)
  maxSingleFundingLossPct: number;   // Max loss in one funding period (default: 0.005)
  maxPositionNotionalUsd: number;    // Hard cap on total notional

  // Execution
  twapChunkSizeUsd: number;          // TWAP chunk size (default: 50_000)
  twapIntervalMs: number;            // Between chunks (default: 300_000 = 5 min)
  spotSlippageBps: number;           // Uniswap slippage (default: 50 = 0.5%)
  perpSlippageBps: number;           // Perpl slippage (default: 30 = 0.3%)
  legFailureTimeoutMs: number;       // Max time between legs (default: 60_000)

  // Monitoring
  fundingCheckIntervalMs: number;    // Poll funding rate (default: 300_000 = 5 min)
  rebalanceCheckIntervalMs: number;  // Check delta drift (default: 60_000 = 1 min)
  reportIntervalMs: number;          // PnL report interval (default: 28_800_000 = 8h)

  // Infrastructure
  databasePath: string;              // SQLite path for state persistence
  minMonBalance: bigint;             // Min MON for gas (default: 1 MON)
}

export function validateCarryConfig(config: CarryConfig): { valid: boolean; errors: string[] }
export function defaultCarryConfig(overrides?: Partial<CarryConfig>): CarryConfig
```

##### 2.2 Carry Strategy (State Machine)

**File**: `src/sdk/trading/strategies/carry.ts`

```typescript
type CarryPhase = 'idle' | 'entering' | 'active' | 'exiting';

interface CarryState {
  phase: CarryPhase;
  position: CarryPosition | null;    // From carry-state.ts
  lastFundingSnapshot: FundingSnapshot | null;
  lastRebalanceTime: number;
  lastExitTime: number;              // For cooldown enforcement
}

interface CarryMetrics {
  currentPhase: CarryPhase;
  annualizedFundingRate: number;
  deltaExposurePct: number;
  liquidationDistance: number;        // % price move to liquidation
  cumulativeFundingEarned: number;
  cumulativeCosts: number;           // Entry + rebalance + gas
  netPnl: number;
  netApy: number;                    // Annualized net yield since entry
  timeInPosition: number;            // ms
  spotValue: number;
  perpNotional: number;
  reserveBalance: number;
  marginHealth: number;              // Ratio above maintenance
}

class CarryStrategy extends EventEmitter {
  constructor(
    config: CarryConfig,
    exchange: Exchange,
    uniswap: UniswapClient,
    wallet: Wallet,
    fundingMonitor: FundingMonitor,
    stateStore: CarryStateStore
  )

  // Lifecycle
  async start(): Promise<void>       // Begin monitoring loop
  async stop(): Promise<void>        // Graceful shutdown (exit if active)
  async forceStop(): Promise<void>   // Emergency: unwind immediately

  // State access
  getState(): CarryState
  getMetrics(): Promise<CarryMetrics>

  // Events emitted:
  // "phase-change" (from: CarryPhase, to: CarryPhase)
  // "entry-started" (config: EntryPlan)
  // "entry-complete" (position: CarryPosition)
  // "entry-failed" (error: Error, partialState: Partial<CarryPosition>)
  // "rebalance" (adjustment: RebalanceResult)
  // "margin-topup" (amount: number, newMarginHealth: number)
  // "exit-started" (reason: string)
  // "exit-complete" (pnl: PnlBreakdown)
  // "alert" (level: "info" | "warning" | "critical", message: string)
  // "report" (metrics: CarryMetrics)
}
```

**State machine transitions**:

```
IDLE
  ├── funding rate > threshold for N periods → ENTERING
  └── stop() called → (no-op, already idle)

ENTERING
  ├── both legs filled → ACTIVE
  ├── perp leg fails → IDLE (nothing to unwind)
  ├── spot leg fails (perp already filled) → unwind perp → IDLE
  ├── timeout (legFailureTimeoutMs) → unwind completed leg → IDLE
  └── stop() called → unwind completed leg → IDLE

ACTIVE
  ├── funding rate < exit threshold → EXITING
  ├── drawdown exceeded → EXITING (emergency)
  ├── liquidation approaching + no reserve → EXITING (emergency)
  ├── delta drift > threshold → rebalance (stay ACTIVE)
  ├── margin low → top up from reserve (stay ACTIVE)
  └── stop() called → EXITING

EXITING
  ├── both legs closed → IDLE
  ├── one leg fails → retry with backoff → eventually force-close
  └── (cannot stop during exit — must complete unwind)
```

**Main loop pseudocode**:

```
while (running):
  match state.phase:
    case 'idle':
      await sleep(fundingCheckIntervalMs)
      snapshot = await fundingMonitor.getCurrentRate()
      if snapshot.annualizedRate > config.minFundingRateApy
         AND confirmationCount >= config.entryConfirmationPeriods
         AND (now - state.lastExitTime) > config.reEntryCooldownMs:
        transition('entering')

    case 'entering':
      result = await executeEntry()
      if result.success:
        transition('active')
      else:
        await handleEntryFailure(result)
        transition('idle')

    case 'active':
      await sleep(min(rebalanceCheckIntervalMs, fundingCheckIntervalMs))
      metrics = await getMetrics()

      if metrics.annualizedFundingRate < config.exitFundingRateApy:
        transition('exiting')
      elif metrics.deltaExposurePct > config.maxDeltaExposurePct:
        await rebalance(metrics)
      elif metrics.marginHealth < config.liquidationBufferMultiple:
        await topUpMargin(metrics)
      elif metrics.netPnl < -(config.maxDrawdownPct * config.totalCapitalAusd):
        transition('exiting')  // emergency

    case 'exiting':
      result = await executeExit()
      logFinalPnl(result)
      transition('idle')
```

##### 2.3 Entry/Exit Execution

**Entry flow (within `executeEntry`)**:

```
1. Calculate sizing:
   - reserveAusd = totalCapital * capitalReservePct
   - perpMarginAusd = (totalCapital - reserveAusd) / 2
   - spotAusd = (totalCapital - reserveAusd) / 2
   - perpSizeBtc = (perpMarginAusd * perpLeverage) / currentBtcPrice
   - spotSizeBtc = spotAusd / currentBtcPrice  (should ≈ perpSizeBtc)

2. Check preconditions:
   - AUSD balance >= totalCapital
   - MON balance >= minMonBalance
   - Uniswap pool liquidity >= 5x spotAusd
   - Perpl OI headroom >= perpSizeBtc
   - No active carry position

3. Execute perp leg (FIRST):
   - Deposit perpMarginAusd to Perpl exchange account (if not already there)
   - Open short via TWAP:
     for each chunk:
       OrderBuilder.forPerp(btcPerpId)
         .openShort()
         .lot(chunkSizeBtc)
         .leverage(config.perpLeverage)
         .immediateOrCancel()
         .build()
       wallet.executeTransaction(order)
   - Record average entry price, total size

4. Execute spot leg (SECOND, within legFailureTimeoutMs):
   - Approve AUSD for SwapRouter02 (if needed)
   - Swap AUSD → WBTC via TWAP:
     for each chunk:
       uniswap.swap({
         tokenIn: AUSD,
         tokenOut: WBTC,
         amountIn: chunkAusd,
         maxSlippageBps: config.spotSlippageBps,
         recipient: wallet.address
       })
   - Record average buy price, total WBTC received

5. Verify delta neutrality:
   - spotValueUsd = wbtcBalance * currentBtcPrice
   - perpNotionalUsd = perpSize * currentBtcPrice
   - deltaExposure = |spotValueUsd - perpNotionalUsd| / max(spotValueUsd, perpNotionalUsd)
   - If deltaExposure > maxDeltaExposurePct: adjust smaller leg

6. Persist state + log entry event

7. If step 4 fails:
   - Log critical alert
   - Unwind perp leg immediately (close short at market)
   - Log partial entry failure
   - Return failure
```

**Exit flow (within `executeExit`)**:

```
1. Close perp short via TWAP (IOC market orders)
2. Sell WBTC → AUSD via Uniswap TWAP
3. Withdraw excess margin from Perpl
4. Calculate PnL breakdown:
   - fundingEarned: cumulative funding payments
   - spotPnl: (WBTC sell price - buy price) * size
   - perpPnl: (short entry - close price) * size
   - costs: entry slippage + exit slippage + rebalancing + gas
   - netPnl: fundingEarned + spotPnl + perpPnl - costs
   - netApy: annualized netPnl / initialCapital / timeInPosition
5. Persist final state, mark position closed
6. Log exit event with PnL breakdown
```

**Test plan** (`test/trading/strategies/carry.test.ts`):

- State machine transitions (all edges)
- Entry: happy path, partial fill, spot leg failure → perp unwind
- Exit: normal, emergency (drawdown), stop command
- Rebalancing: delta drift detection and correction
- Margin top-up from reserve
- Crash recovery: resume from persisted state
- Cooldown enforcement between exit and re-entry
- Entry confirmation periods (require N consecutive periods above threshold)
- Config validation (reject invalid combos)

---

#### Phase 3: CLI Integration

**File**: `src/cli/carry.ts`

```
perplbot carry start [--config <path>]  # Start carry bot with config file or defaults
perplbot carry stop                     # Graceful exit (unwind positions)
perplbot carry stop --force             # Emergency unwind (market orders, no TWAP)
perplbot carry status                   # Current metrics: phase, PnL, rates, positions
perplbot carry history                  # Past carry trades with PnL breakdown
perplbot carry simulate                 # Backtest against historical funding rates
perplbot carry config                   # Show current/default config
```

**Register in** `src/cli/index.ts` alongside existing `trade`, `manage`, `simulate` commands.

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

#### Phase 4: Monitoring and Alerts

##### 4.1 Telegram Integration

Add carry bot commands to existing Telegram bot (`src/bot/handlers/`):

- `/carry_status` — Current carry metrics
- `/carry_stop` — Graceful stop via Telegram

**Alert routing** (push alerts to Telegram automatically):

| Event | Level | Message |
|-------|-------|---------|
| Position entered | Info | "Carry entered: short 2.85 BTC @ $87,420, long 2.84 WBTC" |
| Funding payment | Info (every 8h) | "Funding earned: +$38 this period, +$2,847 total" |
| Rebalance triggered | Warning | "Delta drift 2.3%, rebalancing spot leg" |
| Margin top-up | Warning | "Margin health low (1.3x), topped up $5,000 from reserve" |
| Exit triggered | Info | "Carry exited: net PnL +$2,487 (10.2% APY)" |
| Entry failure | Critical | "Spot leg failed after perp entry. Unwinding perp. Check immediately." |
| Liquidation risk | Critical | "Margin health 1.1x — approaching liquidation. Reserve depleted." |
| Bot crash recovery | Warning | "Bot restarted. Reconciling state. Active position found." |

##### 4.2 MCP Integration

Add carry tools to existing MCP server (`src/mcp/server.ts`):

- `carry_status` — Get current carry metrics
- `carry_start` — Start carry with config
- `carry_stop` — Stop carry bot

---

#### Phase 5: Simulation and Backtesting

**File**: `src/sdk/simulation/carry-sim.ts`

Simulate carry strategy performance using:

1. **Historical funding rates**: Fetch from Perpl API (if available) or index from on-chain events
2. **Historical BTC prices**: For entry/exit timing and slippage estimation
3. **Parameters**: Same CarryConfig used by live strategy
4. **Output**: Time series of PnL, number of entry/exit cycles, max drawdown, Sharpe ratio

```
perplbot carry simulate --days 90 --capital 500000 --min-rate 5
```

**Output**:
```
Carry Backtest Results (90 days)
────────────────────────────────────────
Periods in carry:    67 / 90 days (74.4%)
Entry/exit cycles:   4
Total funding earned: $12,340
Total costs:         -$1,890
Net PnL:             +$10,450
Net APY:             8.5%
Max drawdown:        -$1,200 (-0.24%)
Sharpe ratio:        2.1
```

---

## Alternative Approaches Considered

### B: Standalone Service
Independent process using PerplBot SDK as library. **Rejected**: Duplicates config, wallet, monitoring infrastructure. More deployment complexity without proportional benefit.

### C: Plugin Architecture
Refactor PerplBot for a plugin system. **Rejected**: Over-engineering for current needs. Delays delivery by weeks. Can refactor later if more strategies justify it.

### Atomic Execution via Smart Contract
Deploy a custom contract that executes both legs in one transaction. **Rejected for MVP**: Adds smart contract development/audit overhead. Sequential execution with failure recovery is the industry standard (Talos, Ethena). Can be added later for tighter execution.

### DEX Aggregator (0x, Monorail) Instead of Direct Uniswap
Route spot leg through aggregator for better pricing. **Deferred**: Adds API dependency and trust assumption. Start with direct Uniswap V3, add aggregator routing as optimization later.

---

## Acceptance Criteria

### Functional Requirements

- [ ] Bot monitors BTC funding rate on Perpl and enters carry when rate > configurable threshold
- [ ] Entry executes perp short + spot WBTC buy using TWAP for large orders
- [ ] Bot maintains delta neutrality by rebalancing when drift exceeds threshold
- [ ] Bot exits when funding drops below threshold, drawdown exceeded, or manual stop
- [ ] State persists to SQLite and recovers correctly after crash/restart
- [ ] All parameters are configurable via CarryConfig with sensible defaults
- [ ] Entry failure on spot leg triggers automatic perp unwind

### Non-Functional Requirements

- [ ] Handles >$500k capital deployment safely
- [ ] Perp leg executes before spot leg (sequential, not atomic)
- [ ] TWAP splits orders into configurable chunks with price deviation guards
- [ ] Liquidation buffer maintained at configurable multiple above maintenance
- [ ] MON gas balance monitored and alerted when low
- [ ] All trades and events logged to SQLite with timestamps

### Quality Gates

- [ ] Unit tests for: carry state machine, TWAP engine, funding monitor, Uniswap client, carry state persistence
- [ ] Integration test: full entry/exit cycle on Monad testnet
- [ ] Dry-run simulation passes on forked mainnet state
- [ ] Config validation rejects invalid parameter combinations
- [ ] Test plan documented in `tasks/carry-bot-test-plan.md`

---

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Net APY from carry | >5% annualized | `carry status` net APY field |
| Delta exposure | <2% during active carry | Rebalance frequency and peak drift |
| Uptime | >99% (bot running, monitoring) | Process monitoring |
| Entry/exit slippage | <0.5% combined | `carry history` cost breakdown |
| Time to enter carry | <30 minutes for $500k position | TWAP completion time |
| Crash recovery time | <60 seconds to reconcile and resume | Measured from restart |

---

## Dependencies & Prerequisites

### Hard Dependencies (Must Exist Before Implementation)

| Dependency | Status | Notes |
|------------|--------|-------|
| PerplBot SDK (wallet, contracts, API) | Exists | `src/sdk/` — fully functional |
| Monad mainnet RPC | Live | `https://rpc.monad.xyz` |
| Perpl mainnet exchange | Live | `0x34B6552d...` per config.ts |
| Uniswap V3 on Monad | Live | Addresses confirmed via Uniswap docs |
| WBTC on Monad | Live | `0x0555e30d...` on MonadScan |
| AUSD on Monad | Live | `0x00000000eF...` — Perpl collateral |

### Research Items (Resolve During Phase 1)

| Item | Risk | Resolution |
|------|------|-----------|
| BTC perp ID on mainnet | Medium | Query `getPerpetualInfo()` for each mainnet perp ID |
| AUSD/WBTC pool existence | Medium | Query Uniswap V3 factory for pool; may need WMON routing |
| AUSD/WBTC pool liquidity depth | High | Check TVL; if <$2.5M may need aggregator or slower TWAP |
| Perpl withdrawal timelock | Medium | Test `decreasePositionCollateral` on testnet |
| Mainnet ABI compatibility | Low | Compare testnet vs mainnet contract bytecode |
| Historical funding rate data | Low | Check Perpl API; fallback to on-chain indexing |

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Spot leg fails after perp entry | Medium | High ($12.5k+ loss at 5% BTC move) | Auto-unwind perp within 60s; alert operator |
| Funding rate goes deeply negative | Medium | Medium ($250/period at -0.1%) | Exit threshold + single-period loss limit |
| Uniswap pool too shallow for $500k | Medium | High (massive slippage) | Pre-entry liquidity check; TWAP; aggregator fallback |
| Bot crashes during active position | Low | Medium (orphaned positions) | State persistence + on-chain reconciliation |
| WBTC depegs from BTC | Very Low | High (basis risk) | Monitor WBTC/BTC ratio; exit if deviation > 1% |
| Monad chain congestion | Low | Medium (stuck txs) | Gas escalation; nonce management; emergency exit via higher gas |
| Perpl exchange halted | Very Low | High (stuck short) | Detect via API; alert operator; spot leg can still exit |
| Key compromise | Very Low | Critical (total loss) | DelegatedAccount pattern (Phase 2 enhancement) |

---

## Future Considerations

1. **DelegatedAccount pattern**: Use operator/owner wallet separation for mainnet security
2. **DEX aggregator routing**: Add 0x or Monorail for better spot execution
3. **Multi-asset carry**: Extend to ETH, SOL perpetuals
4. **Reverse carry**: Long perp + short spot (via lending) when funding is negative
5. **Cross-venue arbitrage**: Compare Perpl funding vs other perp DEXes
6. **Atomic execution contract**: Deploy a multicall contract for same-tx entry/exit
7. **Reserve fund strategy**: Invest reserve in stablecoin yields (Aave on Monad)

---

## Documentation Plan

- [ ] Update README.md with carry bot section (after implementation)
- [ ] Add `CARRY_BOT.md` usage guide with config examples
- [ ] Document deployment checklist for mainnet carry bot
- [ ] Add carry bot metrics to existing MCP/chatbot tool documentation

---

## References & Research

### Internal References

- Brainstorm: `docs/brainstorms/2026-03-07-carry-bot-brainstorm.md`
- Grid strategy pattern: `src/sdk/trading/strategies/grid.ts:158-264`
- Market maker pattern: `src/sdk/trading/strategies/marketMaker.ts:63-230`
- Order builder: `src/sdk/trading/orders.ts:63-262`
- Funding rate access: `src/sdk/trading/portfolio.ts:390-415`
- PerpetualInfo (funding fields): `src/sdk/contracts/Exchange.ts:104-124`
- Strategy simulation: `src/sdk/simulation/strategy-sim.ts:223-491`
- State tracker: `src/sdk/state/exchange.ts:113-462`
- Mainnet config: `src/sdk/config.ts:37-56`
- Mainnet perp IDs: `src/sdk/state/exchange.ts:46-53`

### External References

- [Uniswap V3 Monad Deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/monad-deployments)
- [Uniswap V3 Single Swaps Guide](https://docs.uniswap.org/contracts/v3/guides/swaps/single-swaps)
- [WBTC on MonadScan](https://monadscan.com/token/0x0555e30da8f98308edb960aa94c0db47230d2b9c)
- [AUSD (Agora Dollar)](https://www.agora.finance/blog/ausd-now-borderless-onchain)
- [Ethena Delta-Neutral Strategy](https://docs.ethena.fi/solution-overview/usde-overview/delta-neutral-examples)
- [Ethena Funding Risk Data](https://docs.ethena.fi/solution-overview/risks/funding-risk)
- [Talos Multi-Leg Algo Execution](https://www.talos.com/insights/how-talos-multi-leg-algos-slash-execution-slippage-for-basis-trades)
- [tread.fi Delta Neutral Bot](https://docs.tread.fi/bots/delta-neutral-bot)
- [50shadesofgwei/funding-rate-arbitrage](https://github.com/50shadesofgwei/funding-rate-arbitrage) (open-source reference)
- [0x Monad Ecosystem](https://0x.org/post/powering-the-monad-ecosystem-with-swap-api)
- [Monad DeFi TVL](https://defillama.com/chain/monad)

### Related Work

- PerplBot roadmap: delta-neutral strategy, Uniswap integration (both listed as TODO in README)
- Lessons: `~/workspace/work-log/lessons.md`, `~/workspace/perplbot/tasks/lessons.md`
