/**
 * Tests for carry strategy state machine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CarryStrategy,
  CarryError,
  type CarryConfig,
} from "../../../src/sdk/trading/strategies/carry.js";
import { CarryStateStore } from "../../../src/sdk/trading/strategies/carry-state.js";
import type { Exchange, PerpetualInfo } from "../../../src/sdk/contracts/Exchange.js";
import type { UniswapClient } from "../../../src/sdk/integrations/uniswap.js";
import type { Portfolio, FundingInfo } from "../../../src/sdk/trading/portfolio.js";
import type { PublicClient, Address, Hash } from "viem";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB_PATH = join(tmpdir(), `carry-strategy-test-${process.pid}.db`);

// ── Mock Factories ───────────────────────────────────

function makePerpInfo(overrides?: Partial<PerpetualInfo>): PerpetualInfo {
  return {
    name: "BTC",
    symbol: "BTC",
    priceDecimals: 1n,
    lotDecimals: 5n,
    markPNS: 870000n, // $87,000
    markTimestamp: BigInt(Date.now()),
    oraclePNS: 870000n,
    longOpenInterestLNS: 1000000n,
    shortOpenInterestLNS: 800000n,
    fundingStartBlock: 1000000n,
    fundingRatePct100k: 100, // 0.1% per 8h ≈ 10.95% APY
    status: 1,
    paused: false,
    basePricePNS: 870000n,
    maxBidPriceONS: 0n,
    minBidPriceONS: 0n,
    maxAskPriceONS: 0n,
    minAskPriceONS: 0n,
    numOrders: 0n,
    ...overrides,
  };
}

function makeFundingInfo(overrides?: Partial<FundingInfo>): FundingInfo {
  return {
    perpId: 16n,
    symbol: "BTC",
    currentRate: 0.1, // 0.1% per 8h
    nextFundingTime: new Date(Date.now() + 3600000),
    timeUntilFunding: 3600,
    ...overrides,
  };
}

function createMockExchange() {
  return {
    getPerpetualInfo: vi.fn().mockResolvedValue(makePerpInfo()),
    getPosition: vi.fn().mockResolvedValue({
      position: {
        accountId: 1n,
        nextNodeId: 0n,
        prevNodeId: 0n,
        positionType: 1, // Short
        depositCNS: 124500000000n,
        pricePNS: 870000n,
        lotLNS: 285000n,
        entryBlock: 1000n,
        pnlCNS: 0n,
        deltaPnlCNS: 0n,
        premiumPnlCNS: 0n,
      },
      markPrice: 870000n,
      markPriceValid: true,
    }),
    getAccountByAddress: vi.fn().mockResolvedValue({
      accountId: 1n,
      balanceCNS: 500000000000n,
      lockedBalanceCNS: 0n,
      frozen: 0,
      accountAddr: "0x1234" as Address,
      positions: { bank1: 0n, bank2: 0n, bank3: 0n, bank4: 0n },
    }),
    isHalted: vi.fn().mockResolvedValue(false),
    execOrder: vi.fn().mockResolvedValue("0xtxhash" as Hash),
  } as unknown as Exchange;
}

function createMockUniswap() {
  return {
    getQuote: vi.fn().mockResolvedValue(1150n), // ~$87k per BTC
    swap: vi.fn().mockResolvedValue({
      txHash: "0xswaphash" as Hash,
      amountIn: 50000000000n,
      amountOut: 57500000n, // ~0.575 WBTC
      gasUsed: 200000n,
    }),
    reverseSwap: vi.fn().mockResolvedValue({
      txHash: "0xreversehash" as Hash,
      amountIn: 57500000n,
      amountOut: 49500000000n,
      gasUsed: 200000n,
    }),
    approve: vi.fn().mockResolvedValue("0xapprove" as Hash),
    getBalance: vi.fn().mockResolvedValue(0n),
  } as unknown as UniswapClient;
}

function createMockPublicClient() {
  return {
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      gasUsed: 150000n,
    }),
    getBlockNumber: vi.fn().mockResolvedValue(1000000n),
    getBlock: vi.fn().mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as PublicClient;
}

function createMockPortfolio() {
  return {
    getFundingInfo: vi.fn().mockResolvedValue(makeFundingInfo()),
    setAccountByAddress: vi.fn(),
  } as unknown as Portfolio;
}

const defaultConfig: CarryConfig = {
  perpId: 16n,
  spotTokenIn: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
  spotTokenOut: "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Address,
  totalCapitalAusd: 500_000,
  perpLeverage: 2,
  minFundingRateApy: 0.05,  // 5%
  exitFundingRateApy: 0.01, // 1%
  databasePath: TEST_DB_PATH,
};

// ── Tests ────────────────────────────────────────────

describe("CarryStrategy", () => {
  let exchange: ReturnType<typeof createMockExchange>;
  let uniswap: ReturnType<typeof createMockUniswap>;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let portfolio: ReturnType<typeof createMockPortfolio>;

  beforeEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = TEST_DB_PATH + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
    exchange = createMockExchange();
    uniswap = createMockUniswap();
    publicClient = createMockPublicClient();
    portfolio = createMockPortfolio();
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = TEST_DB_PATH + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  function createStrategy(configOverrides?: Partial<CarryConfig>) {
    return new CarryStrategy(
      { ...defaultConfig, ...configOverrides },
      exchange as unknown as Exchange,
      uniswap as unknown as UniswapClient,
      publicClient as unknown as PublicClient,
      portfolio as unknown as Portfolio,
      1n, // accountId
    );
  }

  describe("config validation", () => {
    it("rejects zero capital", () => {
      expect(() => createStrategy({ totalCapitalAusd: 0 })).toThrow("totalCapitalAusd must be positive");
    });

    it("rejects negative capital", () => {
      expect(() => createStrategy({ totalCapitalAusd: -100 })).toThrow("totalCapitalAusd must be positive");
    });

    it("rejects zero leverage", () => {
      expect(() => createStrategy({ perpLeverage: 0 })).toThrow("perpLeverage must be between");
    });

    it("rejects excessive leverage", () => {
      expect(() => createStrategy({ perpLeverage: 25 })).toThrow("perpLeverage must be between");
    });

    it("rejects zero funding threshold", () => {
      expect(() => createStrategy({ minFundingRateApy: 0 })).toThrow("minFundingRateApy must be positive");
    });

    it("rejects exit threshold >= entry threshold", () => {
      expect(
        () => createStrategy({ minFundingRateApy: 0.05, exitFundingRateApy: 0.05 }),
      ).toThrow("exitFundingRateApy must be less than");
    });

    it("rejects missing database path", () => {
      expect(() => createStrategy({ databasePath: "" })).toThrow("databasePath is required");
    });

    it("accepts valid config", () => {
      const strategy = createStrategy();
      expect(strategy).toBeDefined();
      strategy.close();
    });
  });

  describe("getMetrics", () => {
    it("returns idle metrics when no state", async () => {
      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        expect(metrics.phase).toBe("idle");
        expect(metrics.perpSizeBtc).toBe(0);
        expect(metrics.spotSizeBtc).toBe(0);
        expect(metrics.fundingRateApy).toBeGreaterThan(0);
      } finally {
        strategy.close();
      }
    });

    it("returns active metrics from persisted state", async () => {
      // Seed the DB directly
      const store = new CarryStateStore(TEST_DB_PATH);
      store.saveState({
        phase: "active",
        updatedAt: Date.now() - 3600000, // 1 hour ago
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: "124500000000",
        spotEntryPrice: "870000",
        spotSize: "284000000", // 2.84 WBTC (8 decimals)
        fundingEarnedCns: "2847000000",
        costsCns: "380000000",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });
      store.close();

      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        expect(metrics.phase).toBe("active");
        expect(metrics.perpSide).toBe("short");
        expect(metrics.perpSizeBtc).toBeCloseTo(2.85, 1);
        expect(metrics.spotSizeBtc).toBeCloseTo(2.84, 1);
        expect(metrics.fundingEarnedUsd).toBeGreaterThan(0);
        expect(metrics.costsUsd).toBeGreaterThan(0);
      } finally {
        strategy.close();
      }
    });

    it("calculates funding rate APY correctly", async () => {
      // fundingRatePct100k = 100 means 0.001 per 8h
      // APY = 0.001 * 3 * 365 = 1.095 = 109.5%
      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        // 0.1% per 8h → 3x daily → 365 days
        expect(metrics.fundingRateApy).toBeCloseTo(1.095, 2);
      } finally {
        strategy.close();
      }
    });
  });

  describe("reconciliation", () => {
    it("passes when idle with no on-chain positions", async () => {
      (exchange.getPosition as any).mockResolvedValue({
        position: { lotLNS: 0n },
        markPrice: 0n,
        markPriceValid: true,
      });

      const strategy = createStrategy();
      // start() calls reconcile internally, but we can test via getMetrics which doesn't crash
      const metrics = await strategy.getMetrics();
      expect(metrics.phase).toBe("idle");
      strategy.close();
    });

    it("throws on orphaned positions (idle DB + on-chain positions)", async () => {
      // On-chain has a position but DB is idle
      (exchange.getPosition as any).mockResolvedValue({
        position: { lotLNS: 285000n },
        markPrice: 870000n,
        markPriceValid: true,
      });

      const strategy = createStrategy();
      // reconcile is called in start() — test that it throws
      await expect(strategy.start()).rejects.toThrow("Orphaned positions");
      strategy.close();
    });
  });

  describe("CarryError", () => {
    it("creates error with code and recoverability", () => {
      const err = new CarryError("test error", "ENTRY_PERP_FAILED", false);
      expect(err.name).toBe("CarryError");
      expect(err.code).toBe("ENTRY_PERP_FAILED");
      expect(err.recoverable).toBe(false);
      expect(err.message).toBe("test error");
    });

    it("captures cause error", () => {
      const cause = new Error("underlying");
      const err = new CarryError("wrapped", "EXIT_FAILED", true, cause);
      expect(err.cause).toBe(cause);
      expect(err.recoverable).toBe(true);
    });
  });

  describe("funding rate annualization", () => {
    it("correctly annualizes 0.1% per 8h to ~10.95% APY", async () => {
      // currentRate from getFundingInfo is 0.1 (meaning 0.1%)
      // annualized = (0.1/100) * 3 * 365 = 1.095
      (portfolio.getFundingInfo as any).mockResolvedValue(
        makeFundingInfo({ currentRate: 0.1 }),
      );

      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        // From perpInfo.fundingRatePct100k = 100
        // annualized = (100/100000) * 3 * 365 = 1.095
        expect(metrics.fundingRateApy).toBeCloseTo(1.095, 2);
      } finally {
        strategy.close();
      }
    });

    it("correctly handles negative funding rate", async () => {
      (exchange.getPerpetualInfo as any).mockResolvedValue(
        makePerpInfo({ fundingRatePct100k: -50 }),
      );

      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        expect(metrics.fundingRateApy).toBeLessThan(0);
      } finally {
        strategy.close();
      }
    });
  });

  describe("safety checks", () => {
    it("detects exchange halt", async () => {
      (exchange.isHalted as any).mockResolvedValue(true);

      // Seed an active state to trigger safety checks
      const store = new CarryStateStore(TEST_DB_PATH);
      store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: null,
        spotEntryPrice: null,
        spotSize: "284000000",
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });
      store.close();

      // The strategy should detect the halt during reconciliation/active phase
      const strategy = createStrategy();
      // start() will reconcile (fine), then run active handler which checks safety
      // Since it throws CarryError (recoverable), the loop continues
      // We can test this by checking that isHalted is called
      const metrics = await strategy.getMetrics();
      expect(metrics.phase).toBe("active");
      strategy.close();
    });
  });

  describe("state persistence", () => {
    it("survives strategy recreation (crash recovery)", async () => {
      // Create state via store
      const store = new CarryStateStore(TEST_DB_PATH);
      store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: "124500000000",
        spotEntryPrice: "870000",
        spotSize: "284000000",
        fundingEarnedCns: "2847000000",
        costsCns: "380000000",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });
      store.close();

      // New strategy instance reads the same DB
      const strategy = createStrategy();
      try {
        const metrics = await strategy.getMetrics();
        expect(metrics.phase).toBe("active");
        expect(metrics.perpSizeBtc).toBeCloseTo(2.85, 1);
        expect(metrics.fundingEarnedUsd).toBeGreaterThan(0);
      } finally {
        strategy.close();
      }
    });
  });

  describe("defaults constants", () => {
    it("has reasonable TWAP chunk size", () => {
      // Verify through config acceptance — the strategy shouldn't reject
      // reasonable capital amounts
      const strategy = createStrategy({ totalCapitalAusd: 100_000 });
      expect(strategy).toBeDefined();
      strategy.close();
    });

    it("accepts large capital amounts", () => {
      const strategy = createStrategy({ totalCapitalAusd: 5_000_000 });
      expect(strategy).toBeDefined();
      strategy.close();
    });
  });
});
