# Carry Bot on Perpl/Uniswap (AUSD-BTC)

**Date:** 2026-03-07
**Status:** Brainstorm
**Author:** Jordi + Claude

---

## What We're Building

A **fully automated funding rate carry bot** that captures yield from the funding rate differential between BTC spot and BTC perpetual futures. The strategy is delta-neutral:

1. **Spot leg**: Buy BTC on Uniswap (Monad) using AUSD
2. **Perp leg**: Short BTC perpetual on Perpl with AUSD collateral
3. **Carry**: Collect funding rate payments when longs pay shorts (positive funding)

The net position is market-neutral (long spot + short perp = flat BTC exposure). Profit comes purely from funding rate payments minus trading costs.

### Target Profile

| Parameter | Value |
|-----------|-------|
| Capital | >$500k |
| Target yield | >5% APY from funding |
| Automation | Fully automated |
| Leverage (perp) | 2-3x default, configurable |
| Chain | Monad (both legs) |
| Spot venue | Uniswap on Monad |
| Perp venue | Perpl DEX |
| Collateral | AUSD |
| Asset | BTC |

---

## Why This Approach

### Chosen: Integrated PerplBot Strategy Module (Approach A)

Build the carry bot as a new strategy inside PerplBot's existing `src/sdk/trading/strategies/` directory, alongside the grid and market-maker strategies. Add a Uniswap integration module for the spot leg.

**Why this over alternatives:**

- **Leverages existing infrastructure**: Wallet management, contract interactions, simulation framework, CLI/Telegram/MCP interfaces all come for free
- **Follows established patterns**: `grid.ts` and `marketMaker.ts` provide a clear template for strategy structure
- **Fastest to deliver**: No architectural refactoring needed. Add a Uniswap module + carry strategy
- **YAGNI**: A plugin system (Approach C) or standalone service (Approach B) add complexity without proportional benefit right now

**Rejected alternatives:**

- **B: Standalone service** — Too much duplicated infrastructure (config, wallet, monitoring). Makes sense if we need to deploy to separate infra, but not for an MVP
- **C: Plugin architecture** — Over-engineering. Would delay delivery significantly. Can be done later if more strategies justify it

---

## Key Decisions

### 1. Strategy: Delta-Neutral Funding Rate Carry

- Long spot BTC on Uniswap + Short BTC perp on Perpl
- Net BTC exposure: ~0 (delta neutral)
- Revenue: Funding rate payments (shorts receive when funding > 0)
- When funding turns negative (shorts pay longs), the bot should either:
  - Exit both positions (close carry)
  - Reverse the carry (long perp + short spot via Uniswap) if the venue supports it
  - Hold and wait for funding to flip back (if cost is tolerable)

### 2. Spot Leg via Uniswap on Monad

- New integration module: `src/sdk/integrations/uniswap.ts`
- Swap AUSD -> WBTC (or equivalent BTC-wrapped token on Monad)
- Need to identify: exact Uniswap factory/router addresses on Monad, BTC token address
- Slippage protection for large orders (>$500k means significant market impact)
- May need to split large swaps via TWAP

### 3. Perp Leg via Existing PerplBot SDK

- Use existing `Exchange.ts` contract wrapper
- Open short BTC position with configurable leverage (default 2x)
- Collateral: AUSD deposited to Perpl
- Monitor and manage margin to prevent liquidation

### 4. Fully Automated Orchestration

The carry bot needs an orchestration loop that:

1. **Monitors** funding rates (via Perpl API/WebSocket)
2. **Evaluates** entry criteria (funding rate > threshold, sufficient liquidity)
3. **Enters** carry position (spot buy + perp short atomically as possible)
4. **Monitors** position health (funding accrual, liquidation distance, basis)
5. **Rebalances** if legs diverge (spot value != perp notional)
6. **Exits** when carry is no longer profitable or risk thresholds are breached

### 5. Risk Management (Critical for >$500k)

- **Liquidation buffer**: Maintain perp margin at 2x the maintenance requirement minimum
- **Basis risk monitoring**: Alert if spot-perp price divergence exceeds threshold
- **Rebalancing triggers**: If delta exposure exceeds configurable % of notional, rebalance
- **Funding rate floor**: Minimum annualized funding rate to maintain position (e.g., 3% APY)
- **Max position size**: Cap total exposure relative to market depth
- **Drawdown limit**: Auto-exit if cumulative losses exceed configurable threshold
- **Gas cost tracking**: Ensure rebalancing costs don't eat into funding yield

### 6. Capital Allocation

For a $500k+ deployment with 2x leverage on the perp:

| Component | Allocation |
|-----------|-----------|
| Spot BTC (Uniswap) | ~40% of capital |
| Perp margin (Perpl) | ~40% of capital (supports 2x short) |
| Reserve buffer | ~20% for rebalancing, gas, margin top-ups |

### 7. Configurable Parameters

```typescript
interface CarryConfig {
  // Entry/exit
  minFundingRateApy: number;       // Min annualized funding to enter (e.g., 0.05 = 5%)
  exitFundingRateApy: number;      // Funding rate below which to exit (e.g., 0.01 = 1%)

  // Position sizing
  maxNotionalUsd: number;          // Max total notional exposure
  perpLeverage: number;            // Perp leverage (default: 2)
  capitalReservePct: number;       // % of capital held in reserve (default: 0.2)

  // Risk management
  maxDeltaExposurePct: number;     // Max delta imbalance before rebalance (e.g., 0.02 = 2%)
  liquidationBufferMultiple: number; // Margin buffer above maintenance (default: 2x)
  maxDrawdownPct: number;          // Auto-exit drawdown threshold

  // Execution
  spotSlippageBps: number;         // Max slippage for Uniswap swaps
  rebalanceIntervalMs: number;     // How often to check rebalance need
  fundingCheckIntervalMs: number;  // How often to poll funding rates

  // Venues
  perpMarket: string;              // e.g., "btc"
  spotPair: string;                // e.g., "AUSD/WBTC"
  uniswapRouterAddress: string;    // Router contract on Monad
}
```

---

## Strategy Lifecycle (Detailed)

### Phase 1: Monitoring (Idle)

```
Loop every fundingCheckIntervalMs:
  1. Fetch current funding rate from Perpl
  2. Calculate annualized funding rate
  3. If annualized rate > minFundingRateApy AND no active position:
     → Enter Phase 2
  4. Log funding rate history for analysis
```

### Phase 2: Entry

```
1. Calculate position size:
   - Total capital available
   - Reserve 20% for buffer
   - Split remaining: ~50% spot, ~50% perp margin

2. Execute spot leg:
   - If large order: split into TWAP chunks
   - Swap AUSD → WBTC on Uniswap
   - Record average entry price and total BTC acquired

3. Execute perp leg:
   - Deposit AUSD to Perpl as margin
   - Open short BTC perp matching spot BTC amount
   - Leverage: configured (default 2x)
   - Record entry price

4. Verify delta neutrality:
   - Spot BTC value ≈ Perp short notional
   - If imbalanced > maxDeltaExposurePct: adjust smaller leg

5. Enter Phase 3
```

### Phase 3: Active Carry (Main Loop)

```
Loop every rebalanceIntervalMs:
  1. Check funding rate:
     - If annualized < exitFundingRateApy → Phase 4 (Exit)
     - Track cumulative funding earned

  2. Check delta exposure:
     - Spot value vs perp notional
     - If |delta| > maxDeltaExposurePct → rebalance

  3. Check liquidation distance:
     - If margin < liquidationBufferMultiple * maintenance → add margin
     - If insufficient reserve to top up → Phase 4 (Exit)

  4. Check drawdown:
     - If total PnL < -maxDrawdownPct * initial capital → Phase 4 (Exit)

  5. Report:
     - Current funding rate (annualized)
     - Cumulative funding earned
     - Delta exposure
     - Liquidation distance
     - Net PnL (funding earned - costs - unrealized losses)
```

### Phase 4: Exit

```
1. Close perp short:
   - Place market close order on Perpl
   - Record exit price and realized PnL

2. Sell spot BTC:
   - Swap WBTC → AUSD on Uniswap
   - If large: TWAP exit
   - Record exit price

3. Withdraw margin from Perpl if applicable

4. Calculate final PnL:
   - Funding earned
   - Spot PnL (entry vs exit price difference)
   - Perp PnL (entry vs exit price difference)
   - Gas costs
   - Slippage costs
   - Net carry yield

5. Return to Phase 1 (Monitoring)
```

---

## New Components Required

### 1. Uniswap Integration (`src/sdk/integrations/uniswap.ts`)

- Uniswap V3 (or V2) router interaction via viem
- Swap functions: `swapExactIn`, `swapExactOut`
- Price quote functions: `getQuote`, `getSpotPrice`
- Liquidity depth check: ensure sufficient depth for position size
- TWAP helper: split large swaps over time

### 2. Carry Strategy (`src/sdk/trading/strategies/carry.ts`)

- Implements the 4-phase lifecycle above
- Configurable via `CarryConfig`
- Event emitter for state changes (entered, rebalanced, exited)
- Persistent state (survives restarts): current phase, positions, cumulative PnL

### 3. Funding Rate Monitor (`src/sdk/trading/funding.ts`)

- Poll or subscribe to Perpl funding rate data
- Calculate annualized rate from 8h funding rate
- Historical tracking for analysis
- Threshold alerting

### 4. Carry Simulation (`src/sdk/simulation/carry-sim.ts`)

- Backtest carry strategy against historical funding rates
- Simulate entry/exit with realistic slippage and gas costs
- Monte Carlo scenarios for drawdown analysis

### 5. CLI Commands

- `carry start` — Start the carry bot with config
- `carry stop` — Gracefully exit and unwind positions
- `carry status` — Show current carry position, funding earned, PnL
- `carry history` — Show past carry trades
- `carry simulate` — Run backtest

### 6. Telegram/Chatbot Integration

- Carry status command
- Alerts for entry/exit/rebalance events
- Emergency stop via Telegram

---

## Resolved Questions

### Q1: BTC Token on Monad
**Answer: WBTC.** The spot leg will trade the WBTC/AUSD pair on Uniswap (Monad).

### Q6: Mainnet Readiness
**Answer: Mainnet is live.** Perpl is deployed on Monad mainnet. The carry bot targets mainnet. Need to identify mainnet contract addresses during planning.

---

## Open Questions (Deferred to Planning Phase)

### Q2: Uniswap Deployment on Monad
What are the exact Uniswap factory/router addresses on Monad? Is it official Uniswap V3, a fork, or another AMM? Also need the WBTC token address on Monad.

### Q3: Funding Rate Data Availability
Does Perpl's API expose historical funding rate data? The backtest/simulation component needs historical data. If not available via API, we may need to index it from on-chain events.

### Q4: Atomic Execution
Can both legs (spot buy + perp short) be executed atomically (in the same transaction via a smart contract)? If not, there's execution risk between the two legs. A multicall/batch contract could help.

### Q5: AUSD Sourcing
Where does the initial AUSD come from? Is it minted, bridged, or purchased? This affects the entry flow. The existing PerplBot has a roadmap item for "auto-swap to AUSD" but it's not implemented.

---

## References

- PerplBot repo: `~/workspace/perplbot`
- Existing strategies: `src/sdk/trading/strategies/grid.ts`, `marketMaker.ts`
- Exchange contract: `src/sdk/contracts/Exchange.ts`
- Perpl API types: `src/sdk/api/types.ts`
- Simulation framework: `src/sdk/simulation/`
- Roadmap mentions: delta-neutral strategy, funding arb, Uniswap integration (all planned but not built)
