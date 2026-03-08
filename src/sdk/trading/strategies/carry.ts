/**
 * Delta-neutral funding rate carry strategy
 *
 * Holds a short BTC perpetual on Perpl + long WBTC spot on Uniswap V3.
 * Earns yield from positive funding rates while maintaining delta neutrality.
 *
 * State machine: IDLE → ENTERING → ACTIVE → EXITING → IDLE
 * State persists to SQLite for crash recovery with on-chain reconciliation.
 */

import type { Address, Hash, PublicClient } from "viem";
import type { Exchange } from "../../contracts/Exchange.js";
import type { UniswapClient } from "../../integrations/uniswap.js";
import type { Portfolio, FundingInfo } from "../portfolio.js";
import { priceToPNS, lotToLNS, pnsToPrice, lnsToLot } from "../orders.js";
import { amountToCNS, cnsToAmount } from "../positions.js";
import { OrderBuilder } from "../orders.js";
import { type CarryPhase, type CarryState, CarryStateStore } from "./carry-state.js";

// ── Configuration ────────────────────────────────────

export interface CarryConfig {
  perpId: bigint;
  spotTokenIn: Address;   // AUSD
  spotTokenOut: Address;  // WBTC
  totalCapitalAusd: number;
  perpLeverage: number;
  minFundingRateApy: number;  // Entry threshold (e.g. 0.05 = 5%)
  exitFundingRateApy: number; // Exit threshold (e.g. 0.01 = 1%)
  databasePath: string;
}

/** Hardcoded constants — promote to config when tuning is needed */
const DEFAULTS = {
  RESERVE_PCT: 0.20,
  MAX_DELTA_DRIFT: 0.02,
  LIQ_BUFFER: 2.0,
  MAX_DRAWDOWN: 0.05,
  TWAP_CHUNK_USD: 50_000,
  TWAP_INTERVAL_MS: 300_000,       // 5 min between chunks
  SPOT_SLIPPAGE_BPS: 50,
  PERP_SLIPPAGE_BPS: 30,
  LEG_FAILURE_TIMEOUT_MS: 60_000,
  FUNDING_CHECK_MS: 300_000,       // 5 min
  REBALANCE_CHECK_MS: 60_000,      // 1 min
  CONFIRMATION_PERIODS: 3,
  RE_ENTRY_COOLDOWN_MS: 4 * 3600 * 1000,
  MIN_MON_WEI: 1_000_000_000_000_000_000n, // 1 MON for gas
  MAX_PRICE_DIVERGENCE_BPS: 100,   // 1% max oracle vs spot divergence
  MAX_EXIT_RETRIES: 5,
} as const;

// ── Errors ───────────────────────────────────────────

export type CarryErrorCode =
  | "ENTRY_PERP_FAILED"
  | "ENTRY_SPOT_FAILED_AFTER_PERP"
  | "EXIT_FAILED"
  | "TWAP_PRICE_DEVIATION"
  | "INSUFFICIENT_LIQUIDITY"
  | "INSUFFICIENT_BALANCE"
  | "STATE_RECONCILIATION_FAILED"
  | "REBALANCE_FAILED"
  | "EXCHANGE_HALTED"
  | "MARK_PRICE_INVALID"
  | "PRICE_DIVERGENCE";

export class CarryError extends Error {
  constructor(
    message: string,
    public readonly code: CarryErrorCode,
    public readonly recoverable: boolean,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "CarryError";
  }
}

// ── Metrics ──────────────────────────────────────────

export interface CarryMetrics {
  phase: CarryPhase;
  runningForMs: number | null;
  fundingRateApy: number;
  deltaExposurePct: number;

  perpSide: "short" | null;
  perpSizeBtc: number;
  perpEntryPrice: number;
  perpMarginUsd: number;
  perpLiqDistance: number;

  spotSizeBtc: number;
  spotValueUsd: number;

  fundingEarnedUsd: number;
  costsUsd: number;
  netPnlUsd: number;
  netApyPct: number;

  reserveUsd: number;
}

// ── Tx Verification ──────────────────────────────────

async function verifyReceipt(
  publicClient: PublicClient,
  hash: Hash,
  errorCode: CarryErrorCode,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  });
  if (receipt.status !== "success") {
    throw new CarryError(`Transaction reverted: ${hash}`, errorCode, false);
  }
}

// ── Strategy ─────────────────────────────────────────

export class CarryStrategy {
  private stateStore: CarryStateStore;
  private state: CarryState | null = null;
  private running = false;
  private stopRequested = false;
  private fundingConfirmations = 0;
  private lastExitAt: number | null = null;

  constructor(
    private readonly config: CarryConfig,
    private readonly exchange: Exchange,
    private readonly uniswap: UniswapClient,
    private readonly publicClient: PublicClient,
    private readonly portfolio: Portfolio,
    private readonly accountId: bigint,
  ) {
    this.validateConfig(config);
    this.stateStore = new CarryStateStore(config.databasePath);
  }

  /** Start the carry bot. Blocks until stop() is called. */
  async start(): Promise<void> {
    if (this.running) throw new Error("Carry strategy already running");
    this.running = true;
    this.stopRequested = false;

    console.log("[carry] Starting carry strategy...");

    // Reconcile on startup
    await this.reconcile();

    // Register signal handlers
    const onSignal = () => {
      console.log("[carry] Shutdown signal received, stopping gracefully...");
      this.stopRequested = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      await this.runLoop();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      this.running = false;
      console.log("[carry] Strategy stopped.");
    }
  }

  /** Signal the strategy to stop. Will unwind positions via market orders. */
  async stop(): Promise<void> {
    this.stopRequested = true;
  }

  /** Get current metrics for CLI status display. */
  async getMetrics(): Promise<CarryMetrics> {
    const state = this.state ?? this.stateStore.loadState();
    const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
    const fundingApy = this.annualizeFunding(perpInfo.fundingRatePct100k);
    const markPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);

    if (!state || state.phase === "idle") {
      return {
        phase: "idle",
        runningForMs: null,
        fundingRateApy: fundingApy,
        deltaExposurePct: 0,
        perpSide: null,
        perpSizeBtc: 0,
        perpEntryPrice: 0,
        perpMarginUsd: 0,
        perpLiqDistance: 0,
        spotSizeBtc: 0,
        spotValueUsd: 0,
        fundingEarnedUsd: 0,
        costsUsd: 0,
        netPnlUsd: 0,
        netApyPct: 0,
        reserveUsd: this.config.totalCapitalAusd * DEFAULTS.RESERVE_PCT,
      };
    }

    const perpSize = state.perpSizeLns ? lnsToLot(BigInt(state.perpSizeLns)) : 0;
    const spotSize = state.spotSize ? Number(state.spotSize) / 1e8 : 0; // WBTC 8 decimals
    const perpEntry = state.perpEntryPricePns
      ? pnsToPrice(BigInt(state.perpEntryPricePns))
      : 0;
    const perpMargin = state.perpMarginCns
      ? cnsToAmount(BigInt(state.perpMarginCns))
      : 0;
    const fundingEarned = cnsToAmount(BigInt(state.fundingEarnedCns));
    const costs = cnsToAmount(BigInt(state.costsCns));
    const initialCapital = state.initialCapitalCns
      ? cnsToAmount(BigInt(state.initialCapitalCns))
      : this.config.totalCapitalAusd;

    const spotValueUsd = spotSize * markPrice;
    const perpNotional = perpSize * markPrice;
    const deltaExposure =
      perpNotional > 0 ? Math.abs(spotValueUsd - perpNotional) / perpNotional : 0;

    const netPnl = fundingEarned - costs;
    const runningMs = Date.now() - state.updatedAt;
    const runningDays = runningMs / (24 * 3600 * 1000);
    const netApy = runningDays > 0 ? (netPnl / initialCapital) * (365 / runningDays) : 0;

    return {
      phase: state.phase,
      runningForMs: runningMs,
      fundingRateApy: fundingApy,
      deltaExposurePct: deltaExposure,
      perpSide: "short",
      perpSizeBtc: perpSize,
      perpEntryPrice: perpEntry,
      perpMarginUsd: perpMargin,
      perpLiqDistance: 0, // Calculated from on-chain in full status
      spotSizeBtc: spotSize,
      spotValueUsd,
      fundingEarnedUsd: fundingEarned,
      costsUsd: costs,
      netPnlUsd: netPnl,
      netApyPct: netApy,
      reserveUsd: this.config.totalCapitalAusd * DEFAULTS.RESERVE_PCT,
    };
  }

  // ── Main Loop ────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const phase = this.state?.phase ?? "idle";

        switch (phase) {
          case "idle":
            await this.handleIdle();
            break;
          case "entering":
            await this.handleEntering();
            break;
          case "active":
            await this.handleActive();
            break;
          case "exiting":
            await this.handleExiting();
            break;
        }
      } catch (err) {
        if (err instanceof CarryError) {
          console.error(`[carry] ${err.code}: ${err.message}`);
          if (!err.recoverable) {
            console.error("[carry] Unrecoverable error. Stopping.");
            break;
          }
        } else {
          console.error("[carry] Unexpected error:", err);
        }
      }

      await sleep(1000); // Brief pause between loop iterations
    }

    // If stop requested and we have a position, exit it
    if (this.state && this.state.phase === "active") {
      console.log("[carry] Stop requested while active. Unwinding positions...");
      await this.transitionToExiting();
      await this.handleExiting();
    }
  }

  // ── Phase Handlers ─────────────────────────────────

  private async handleIdle(): Promise<void> {
    // Cooldown after exit
    if (this.lastExitAt) {
      const elapsed = Date.now() - this.lastExitAt;
      if (elapsed < DEFAULTS.RE_ENTRY_COOLDOWN_MS) {
        await sleep(DEFAULTS.FUNDING_CHECK_MS);
        return;
      }
    }

    // Check funding rate
    const fundingInfo = await this.portfolio.getFundingInfo(this.config.perpId);
    const apy = this.annualizeFundingFromInfo(fundingInfo);

    if (apy >= this.config.minFundingRateApy) {
      this.fundingConfirmations++;
      console.log(
        `[carry] Funding rate ${(apy * 100).toFixed(1)}% APY (confirmation ${this.fundingConfirmations}/${DEFAULTS.CONFIRMATION_PERIODS})`,
      );

      if (this.fundingConfirmations >= DEFAULTS.CONFIRMATION_PERIODS) {
        console.log("[carry] Entry threshold met. Beginning entry...");
        this.fundingConfirmations = 0;
        await this.enterPosition();
        return;
      }
    } else {
      if (this.fundingConfirmations > 0) {
        console.log(`[carry] Funding rate ${(apy * 100).toFixed(1)}% APY below threshold, resetting confirmations.`);
      }
      this.fundingConfirmations = 0;
    }

    await sleep(DEFAULTS.FUNDING_CHECK_MS);
  }

  private async handleEntering(): Promise<void> {
    // Entering is handled inline during enterPosition()
    // If we reach here, it means we crashed during entry and reconciled
    if (!this.state) return;

    if (this.state.perpLegComplete && !this.state.spotLegComplete) {
      console.log("[carry] Resuming entry: perp leg complete, executing spot leg...");
      await this.executeSpotEntry();
    } else if (!this.state.perpLegComplete) {
      console.log("[carry] Entry incomplete (no perp leg). Transitioning to idle.");
      this.transitionToIdle();
    }
  }

  private async handleActive(): Promise<void> {
    if (!this.state) return;
    await this.checkSafetyInvariants();

    // Check funding rate for exit signal
    const fundingInfo = await this.portfolio.getFundingInfo(this.config.perpId);
    const apy = this.annualizeFundingFromInfo(fundingInfo);

    if (apy < this.config.exitFundingRateApy) {
      console.log(`[carry] Funding rate ${(apy * 100).toFixed(1)}% below exit threshold. Exiting...`);
      await this.transitionToExiting();
      return;
    }

    // Check drawdown
    const metrics = await this.getMetrics();
    const initialCapital = this.state.initialCapitalCns
      ? cnsToAmount(BigInt(this.state.initialCapitalCns))
      : this.config.totalCapitalAusd;
    if (initialCapital > 0 && metrics.netPnlUsd / initialCapital < -DEFAULTS.MAX_DRAWDOWN) {
      console.log(`[carry] Drawdown ${((metrics.netPnlUsd / initialCapital) * 100).toFixed(1)}% exceeds limit. Emergency exit.`);
      await this.transitionToExiting();
      return;
    }

    // Check delta drift
    if (metrics.deltaExposurePct > DEFAULTS.MAX_DELTA_DRIFT) {
      console.log(`[carry] Delta drift ${(metrics.deltaExposurePct * 100).toFixed(1)}%. Rebalancing...`);
      await this.rebalance();
    }

    await sleep(DEFAULTS.REBALANCE_CHECK_MS);
  }

  private async handleExiting(): Promise<void> {
    if (!this.state) return;

    let retries = 0;
    while (retries < DEFAULTS.MAX_EXIT_RETRIES) {
      try {
        await this.exitPosition();
        return;
      } catch (err) {
        retries++;
        console.error(`[carry] Exit attempt ${retries}/${DEFAULTS.MAX_EXIT_RETRIES} failed:`, err);
        if (retries >= DEFAULTS.MAX_EXIT_RETRIES) {
          console.error("[carry] CRITICAL: Max exit retries reached. Manual intervention required.");
          this.stopRequested = true;
          return;
        }
        // Wait before retrying, but check for second SIGINT to force-quit
        const waited = await interruptibleSleep(DEFAULTS.TWAP_INTERVAL_MS, () => this.stopRequested);
        if (!waited) {
          console.error("[carry] Force-quit requested during exit retry. Stopping with positions open.");
          return;
        }
      }
    }
  }

  // ── Entry Logic ────────────────────────────────────

  private async enterPosition(): Promise<void> {
    await this.checkSafetyInvariants();

    const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
    const markPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);

    // Calculate position sizes
    const tradingCapital = this.config.totalCapitalAusd * (1 - DEFAULTS.RESERVE_PCT);
    const perpCapital = tradingCapital / 2;
    const spotCapital = tradingCapital / 2;
    const perpSizeBtc = perpCapital * this.config.perpLeverage / markPrice;
    // Create entering state
    const stateId = this.stateStore.saveState({
      phase: "entering",
      updatedAt: Date.now(),
      perpLegComplete: false,
      spotLegComplete: false,
      perpEntryPricePns: null,
      perpSizeLns: null,
      perpMarginCns: null,
      spotEntryPrice: null,
      spotSize: null,
      fundingEarnedCns: "0",
      costsCns: "0",
      initialCapitalCns: amountToCNS(this.config.totalCapitalAusd).toString(),
      lastTxHash: null,
    });

    this.state = this.stateStore.loadState();

    try {
      // ── Interleaved TWAP entry ──
      // perp chunk → spot chunk → perp chunk → spot chunk ...
      const chunkSizeUsd = DEFAULTS.TWAP_CHUNK_USD;
      const totalPerpChunks = Math.ceil(perpCapital / chunkSizeUsd);
      const startPrice = markPrice;
      let totalPerpLns = 0n;
      let totalSpotWbtc = 0n;

      let entryComplete = true;
      for (let i = 0; i < totalPerpChunks; i++) {
        if (this.stopRequested) {
          console.log("[carry] Stop requested during entry. Unwinding partial position...");
          entryComplete = false;
          break;
        }

        // Refresh mark price
        const freshInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
        const currentMark = pnsToPrice(freshInfo.markPNS, freshInfo.priceDecimals);

        // Price deviation check
        const deviation = Math.abs(currentMark - startPrice) / startPrice;
        if (deviation > DEFAULTS.MAX_PRICE_DIVERGENCE_BPS / 10000) {
          throw new CarryError(
            `Price moved ${(deviation * 100).toFixed(2)}% during entry`,
            "TWAP_PRICE_DEVIATION",
            true,
          );
        }

        // ── Perp chunk (short) ──
        const perpChunkBtc = Math.min(perpSizeBtc / totalPerpChunks, perpSizeBtc - lnsToLot(totalPerpLns));
        const perpChunkLns = lotToLNS(perpChunkBtc);
        const perpSlippagePrice = currentMark * (1 - DEFAULTS.PERP_SLIPPAGE_BPS / 10000);

        const perpOrder = new OrderBuilder(this.config.perpId)
          .openShort()
          .price(perpSlippagePrice)
          .lotLNS(perpChunkLns)
          .leverage(this.config.perpLeverage)
          .immediateOrCancel()
          .build();

        const perpHash = await this.exchange.execOrder(perpOrder);
        await verifyReceipt(this.publicClient, perpHash as Hash, "ENTRY_PERP_FAILED");
        totalPerpLns += perpChunkLns;

        console.log(`[carry] Perp chunk ${i + 1}/${totalPerpChunks}: short ${perpChunkBtc.toFixed(4)} BTC`);

        // ── Spot chunk (buy WBTC) ──
        const spotChunkAusd = amountToCNS(Math.min(chunkSizeUsd, spotCapital / totalPerpChunks));
        try {
          const expectedOut = await this.uniswap.getQuote(spotChunkAusd);
          const minOut = expectedOut * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
          const spotResult = await this.uniswap.swap(
            spotChunkAusd,
            minOut,
          );
          totalSpotWbtc += spotResult.amountOut;
          console.log(`[carry] Spot chunk ${i + 1}/${totalPerpChunks}: bought WBTC for $${(spotCapital / totalPerpChunks).toFixed(0)}`);
        } catch (err) {
          // Spot leg failed after perp — critical, need to unwind
          console.error("[carry] Spot leg failed after perp entry. Unwinding perp...");
          await this.unwindPerp();
          throw new CarryError(
            "Spot leg failed after perp entry",
            "ENTRY_SPOT_FAILED_AFTER_PERP",
            true,
            err instanceof Error ? err : undefined,
          );
        }

        if (i < totalPerpChunks - 1) {
          await sleep(DEFAULTS.TWAP_INTERVAL_MS);
        }
      }

      // If entry was interrupted, unwind partial positions instead of saving as active
      if (!entryComplete) {
        console.log("[carry] Unwinding partial entry...");
        let unwindOk = true;
        if (totalPerpLns > 0n) {
          try {
            await this.unwindPerp();
          } catch {
            unwindOk = false;
          }
        }
        if (totalSpotWbtc > 0n) {
          try {
            const expectedAusd = await this.uniswap.getQuote(totalSpotWbtc);
            const minAusd = expectedAusd * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
            await this.uniswap.reverseSwap(totalSpotWbtc, minAusd);
          } catch {
            unwindOk = false;
          }
        }
        if (unwindOk) {
          this.transitionToIdle();
        } else {
          console.error("[carry] CRITICAL: Partial unwind failed. State preserved for manual intervention.");
        }
        return;
      }

      // Update state to active
      this.stateStore.saveState({
        id: stateId,
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: priceToPNS(markPrice).toString(),
        perpSizeLns: totalPerpLns.toString(),
        perpMarginCns: amountToCNS(perpCapital).toString(),
        spotEntryPrice: priceToPNS(markPrice).toString(),
        spotSize: totalSpotWbtc.toString(),
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: amountToCNS(this.config.totalCapitalAusd).toString(),
        lastTxHash: null,
      });
      this.state = this.stateStore.loadState();

      console.log(`[carry] Entry complete. Short ${lnsToLot(totalPerpLns).toFixed(4)} BTC perp, long ${Number(totalSpotWbtc) / 1e8} WBTC spot.`);
    } catch (err) {
      if (err instanceof CarryError && err.code === "ENTRY_SPOT_FAILED_AFTER_PERP") {
        this.transitionToIdle();
      }
      throw err;
    }
  }

  private async executeSpotEntry(): Promise<void> {
    // Crash recovery: perp done, spot not done
    if (!this.state) return;

    const spotCapital = this.config.totalCapitalAusd * (1 - DEFAULTS.RESERVE_PCT) / 2;
    const spotChunkAusd = amountToCNS(spotCapital);

    try {
      const expectedOut = await this.uniswap.getQuote(spotChunkAusd);
      const minOut = expectedOut * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
      const result = await this.uniswap.swap(spotChunkAusd, minOut);
      this.stateStore.saveState({
        ...this.state,
        phase: "active",
        spotLegComplete: true,
        spotSize: result.amountOut.toString(),
      });
      this.state = this.stateStore.loadState();
      console.log("[carry] Spot leg completed (crash recovery).");
    } catch {
      console.error("[carry] Spot leg failed during recovery. Unwinding perp...");
      try {
        await this.unwindPerp();
        this.transitionToIdle();
      } catch {
        // Unwind failed — keep state as "entering" so next startup detects orphaned position
        console.error("[carry] CRITICAL: Perp unwind also failed. State preserved for manual intervention.");
      }
    }
  }

  // ── Exit Logic ─────────────────────────────────────

  private async exitPosition(): Promise<void> {
    if (!this.state) return;
    const state = this.state;

    console.log("[carry] Exiting position...");

    // Close perp (buy back short)
    if (state.perpSizeLns && BigInt(state.perpSizeLns) > 0n) {
      const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
      const markPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);
      const slippagePrice = markPrice * (1 + DEFAULTS.PERP_SLIPPAGE_BPS / 10000);

      const closeOrder = new OrderBuilder(this.config.perpId)
        .closeShort()
        .price(slippagePrice)
        .lotLNS(BigInt(state.perpSizeLns))
        .immediateOrCancel()
        .build();

      const hash = await this.exchange.execOrder(closeOrder);
      await verifyReceipt(this.publicClient, hash as Hash, "EXIT_FAILED");
      console.log("[carry] Perp leg closed.");
    }

    // Sell WBTC
    if (state.spotSize && BigInt(state.spotSize) > 0n) {
      const wbtcAmount = BigInt(state.spotSize);
      const expectedAusd = await this.uniswap.getQuote(wbtcAmount);
      const minAusd = expectedAusd * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
      await this.uniswap.reverseSwap(wbtcAmount, minAusd);
      console.log("[carry] Spot leg closed.");
    }

    // Calculate final PnL
    const funding = BigInt(state.fundingEarnedCns);
    const costs = BigInt(state.costsCns);
    const finalPnl = (funding - costs).toString();

    this.stateStore.markClosed(state.id, finalPnl);
    this.state = null;
    this.lastExitAt = Date.now();

    console.log(`[carry] Position closed. Net funding: $${cnsToAmount(funding).toFixed(2)}, costs: $${cnsToAmount(costs).toFixed(2)}`);
  }

  private async unwindPerp(): Promise<void> {
    try {
      const { position } = await this.exchange.getPosition(
        this.config.perpId,
        this.accountId,
      );

      if (position.lotLNS > 0n) {
        const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
        const markPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);
        const slippagePrice = markPrice * (1 + DEFAULTS.PERP_SLIPPAGE_BPS / 10000);

        const closeOrder = new OrderBuilder(this.config.perpId)
          .closeShort()
          .price(slippagePrice)
          .lotLNS(position.lotLNS)
          .immediateOrCancel()
          .build();

        const hash = await this.exchange.execOrder(closeOrder);
        await verifyReceipt(this.publicClient, hash as Hash, "EXIT_FAILED");
        console.log("[carry] Emergency perp unwind complete.");
      }
    } catch (err) {
      console.error("[carry] CRITICAL: Perp unwind failed:", err);
      throw err;
    }
  }

  // ── Rebalancing ────────────────────────────────────

  private async rebalance(): Promise<void> {
    if (!this.state) return;

    const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
    const markPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);

    const perpSize = this.state.perpSizeLns ? lnsToLot(BigInt(this.state.perpSizeLns)) : 0;
    const spotSize = this.state.spotSize ? Number(this.state.spotSize) / 1e8 : 0;
    const perpNotional = perpSize * markPrice;
    const spotNotional = spotSize * markPrice;

    if (perpNotional === 0) return;

    const drift = (spotNotional - perpNotional) / perpNotional;

    if (Math.abs(drift) > DEFAULTS.MAX_DELTA_DRIFT) {
      // If spot > perp, sell some WBTC; if perp > spot, buy some WBTC
      const adjustmentUsd = Math.abs(drift) * perpNotional / 2;
      console.log(`[carry] Rebalancing: delta drift ${(drift * 100).toFixed(2)}%, adjusting $${adjustmentUsd.toFixed(0)}`);

      try {
        if (drift > 0) {
          // Spot too big, sell WBTC
          const wbtcToSell = BigInt(Math.round(adjustmentUsd / markPrice * 1e8));
          const expectedAusd = await this.uniswap.getQuote(wbtcToSell);
          const minAusd = expectedAusd * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
          await this.uniswap.reverseSwap(wbtcToSell, minAusd);
        } else {
          // Spot too small, buy WBTC
          const ausdToSpend = amountToCNS(adjustmentUsd);
          const expectedWbtc = await this.uniswap.getQuote(ausdToSpend);
          const minWbtc = expectedWbtc * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
          await this.uniswap.swap(ausdToSpend, minWbtc);
        }

        // Update spot size in state
        const newSpotBalance = await this.uniswap.getBalance(this.config.spotTokenOut);
        this.stateStore.saveState({
          ...this.state,
          spotSize: newSpotBalance.toString(),
          costsCns: (BigInt(this.state.costsCns) + amountToCNS(adjustmentUsd * 0.003)).toString(), // Estimate swap cost
        });
        this.state = this.stateStore.loadState();
      } catch (err) {
        console.error("[carry] Rebalance failed:", err);
      }
    }
  }

  // ── Reconciliation ─────────────────────────────────

  /**
   * On startup, reconcile DB state against on-chain positions.
   * Uses the state matrix from the plan.
   */
  private async reconcile(): Promise<void> {
    this.state = this.stateStore.loadState();
    const dbPhase = this.state?.phase ?? "idle";

    // Check on-chain state
    let hasPerp = false;
    let hasSpot = false;

    try {
      const { position } = await this.exchange.getPosition(this.config.perpId, this.accountId);
      hasPerp = position.lotLNS > 0n;
    } catch {
      // No position
    }

    try {
      const spotBalance = await this.uniswap.getBalance(this.config.spotTokenOut);
      hasSpot = spotBalance > 0n;
    } catch {
      // Token might not exist or other error
    }

    console.log(`[carry] Reconciliation: DB phase=${dbPhase}, on-chain perp=${hasPerp}, spot=${hasSpot}`);

    switch (dbPhase) {
      case "idle":
        if (hasPerp || hasSpot) {
          console.error(
            "[carry] ALERT: Orphaned position detected (DB=idle but on-chain positions exist). Refusing to start.",
          );
          throw new CarryError(
            "Orphaned positions detected",
            "STATE_RECONCILIATION_FAILED",
            false,
          );
        }
        break;

      case "entering": {
        const enterState = this.state!; // Non-null: loadState() only returns non-idle phases
        if (enterState.perpLegComplete && !enterState.spotLegComplete) {
          if (hasPerp && !hasSpot) {
            console.log("[carry] Crash during entry (perp done, spot pending). Unwinding perp.");
            try {
              await this.unwindPerp();
              this.transitionToIdle();
            } catch {
              console.error("[carry] CRITICAL: Perp unwind failed during reconciliation. Manual intervention required.");
              throw new CarryError("Perp unwind failed during reconciliation", "STATE_RECONCILIATION_FAILED", false);
            }
          }
        } else if (!enterState.perpLegComplete) {
          console.log("[carry] Crash during entry (perp not done). Transitioning to idle.");
          this.transitionToIdle();
        }
        break;
      }

      case "active": {
        const activeState = this.state!; // Non-null: loadState() only returns non-idle phases
        if (hasPerp && hasSpot) {
          console.log("[carry] Resuming active position.");
          // State is fine, continue
        } else if (!hasPerp && hasSpot) {
          console.error("[carry] ALERT: Perp liquidated! Selling WBTC...");
          try {
            const spotBalance = await this.uniswap.getBalance(this.config.spotTokenOut);
            const expectedAusd = await this.uniswap.getQuote(spotBalance);
            const minAusd = expectedAusd * BigInt(10000 - DEFAULTS.SPOT_SLIPPAGE_BPS) / 10000n;
            await this.uniswap.reverseSwap(spotBalance, minAusd);
          } catch (err) {
            console.error("[carry] Failed to sell WBTC:", err);
          }
          this.stateStore.markClosed(activeState.id, activeState.fundingEarnedCns);
          this.state = null;
        } else if (hasPerp && !hasSpot) {
          console.error("[carry] ALERT: WBTC missing. Manual intervention required.");
          throw new CarryError(
            "WBTC missing from wallet during active carry",
            "STATE_RECONCILIATION_FAILED",
            false,
          );
        } else {
          // Neither — both closed somehow
          console.log("[carry] Both legs closed. Marking as closed.");
          this.stateStore.markClosed(activeState.id, activeState.fundingEarnedCns);
          this.state = null;
        }
        break;
      }

      case "exiting":
        console.log("[carry] Resuming exit...");
        // Continue exit from where left off
        break;
    }
  }

  // ── Safety Checks ──────────────────────────────────

  private async checkSafetyInvariants(): Promise<void> {
    // Exchange halted?
    const halted = await this.exchange.isHalted();
    if (halted) {
      throw new CarryError("Exchange is halted", "EXCHANGE_HALTED", true);
    }

    // Mark price valid?
    const { markPriceValid } = await this.exchange.getPosition(
      this.config.perpId,
      this.accountId,
    );
    if (!markPriceValid) {
      throw new CarryError("Mark price is stale/invalid", "MARK_PRICE_INVALID", true);
    }

    // Price divergence check (Perpl mark vs Uniswap quote)
    const perpInfo = await this.exchange.getPerpetualInfo(this.config.perpId);
    const perpPrice = pnsToPrice(perpInfo.markPNS, perpInfo.priceDecimals);

    try {
      const oneAusd = amountToCNS(1); // $1 worth
      const wbtcQuote = await this.uniswap.getQuote(oneAusd);

      if (wbtcQuote > 0n) {
        // AUSD has 6 decimals, WBTC has 8 decimals
        // Price = AUSD_amount / WBTC_amount * 10^(8-6) = amount_ratio * 100
        const uniswapBtcPrice = Number(oneAusd) * 1e2 / Number(wbtcQuote);
        const divergence = Math.abs(perpPrice - uniswapBtcPrice) / perpPrice;

        if (divergence > DEFAULTS.MAX_PRICE_DIVERGENCE_BPS / 10000) {
          throw new CarryError(
            `Perpl/Uniswap price divergence: ${(divergence * 100).toFixed(2)}%`,
            "PRICE_DIVERGENCE",
            true,
          );
        }
      }
    } catch (err) {
      if (err instanceof CarryError) throw err;
      // Quote failed — not critical, log and continue
      console.warn("[carry] Uniswap quote check failed:", (err as Error).message);
    }
  }

  // ── State Transitions ──────────────────────────────

  private transitionToIdle(): void {
    if (this.state) {
      this.stateStore.markClosed(this.state.id, this.state.fundingEarnedCns);
    }
    this.state = null;
    this.fundingConfirmations = 0;
  }

  private async transitionToExiting(): Promise<void> {
    if (!this.state) return;
    this.stateStore.saveState({
      ...this.state,
      phase: "exiting",
    });
    this.state = this.stateStore.loadState();
  }

  // ── Helpers ────────────────────────────────────────

  private annualizeFunding(ratePct100k: number): number {
    // ratePct100k is the 8-hour rate in hundredths of a percent (100k scale)
    // e.g., 100 = 0.001 = 0.1% per 8h
    const ratePerPeriod = ratePct100k / 100_000;
    return ratePerPeriod * 3 * 365; // 3 periods/day * 365 days
  }

  private annualizeFundingFromInfo(info: FundingInfo): number {
    // currentRate is percentage per 8h (e.g., 0.1 = 0.1%)
    return (info.currentRate / 100) * 3 * 365;
  }

  private validateConfig(config: CarryConfig): void {
    if (config.totalCapitalAusd <= 0) {
      throw new Error("totalCapitalAusd must be positive");
    }
    if (config.perpLeverage <= 0 || config.perpLeverage > 20) {
      throw new Error("perpLeverage must be between 0 and 20");
    }
    if (config.minFundingRateApy <= 0) {
      throw new Error("minFundingRateApy must be positive");
    }
    if (config.exitFundingRateApy >= config.minFundingRateApy) {
      throw new Error("exitFundingRateApy must be less than minFundingRateApy");
    }
    if (!config.databasePath) {
      throw new Error("databasePath is required");
    }
  }

  /** Close the state store (for cleanup) */
  close(): void {
    this.stateStore.close();
  }
}

// ── Utilities ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that can be interrupted by a condition check. Returns false if interrupted. */
function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (shouldStop()) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve(false);
      }
    }, 1000);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      resolve(true);
    }, ms);
  });
}
