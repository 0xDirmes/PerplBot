/**
 * Unit tests for new Exchange read methods
 * Tests: getPositions, getLiquidationInfo, getMarginFractions, getFundingInterval,
 *        getFundingSumAtBlock, getPositionIds, numberOfAccounts, getMinAccountOpenCNS,
 *        getMinimumPostCNS, getRecycleFeeCNS, isHalted, getOrderLocks,
 *        getPerpOrderLocks, getWithdrawAllowanceData
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, PublicClient } from "viem";
import {
  Exchange,
  PositionType,
  type LiquidationInfo,
  type MarginFractions,
  type OrderLock,
} from "../../src/sdk/contracts/Exchange.js";

// Shared mock setup
const EXCHANGE_ADDR = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" as Address;

function createMockPublicClient() {
  return {
    readContract: vi.fn(),
    getBlockNumber: vi.fn(),
    chain: { id: 10143 },
  } as unknown as PublicClient;
}

describe("Exchange new read methods", () => {
  let exchange: Exchange;
  let mockClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    mockClient = createMockPublicClient();
    exchange = new Exchange(EXCHANGE_ADDR, mockClient);
  });

  // ============ getPositions ============

  describe("getPositions", () => {
    it("should return positions with defaults", async () => {
      const mockPositions = [
        {
          accountId: 1n,
          nextNodeId: 0n,
          prevNodeId: 0n,
          positionType: 0,
          depositCNS: 1000000n,
          pricePNS: 5000000n,
          lotLNS: 100000n,
          entryBlock: 1000n,
          pnlCNS: 50000n,
          deltaPnlCNS: 10000n,
          premiumPnlCNS: 5000n,
        },
      ];

      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        mockPositions,
        1n,
        5000000n,
        1,
      ]);

      const result = await exchange.getPositions(16n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getPositions",
        args: [16n, 0n, 100n],
      });

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].accountId).toBe(1n);
      expect(result.positions[0].positionType).toBe(PositionType.Long);
      expect(result.positions[0].depositCNS).toBe(1000000n);
      expect(result.numPositions).toBe(1n);
      expect(result.refPricePNS).toBe(5000000n);
      expect(result.refPriceStatus).toBe(1);
    });

    it("should pass custom page params", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        [],
        0n,
        0n,
        0,
      ]);

      await exchange.getPositions(32n, 5n, 50n);

      expect(mockClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "getPositions",
          args: [32n, 5n, 50n],
        }),
      );
    });

    it("should handle empty positions", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        [],
        0n,
        0n,
        0,
      ]);

      const result = await exchange.getPositions(16n);
      expect(result.positions).toHaveLength(0);
      expect(result.numPositions).toBe(0n);
    });
  });

  // ============ getLiquidationInfo ============

  describe("getLiquidationInfo", () => {
    it("should return all liquidation fields", async () => {
      const mockResult = {
        liqInsAmtPer100K: 500n,
        liqUserAmtPer100K: 300n,
        liqProtocolAmtPer100K: 200n,
        btlPriceThreshPer100K: 9500n,
        btlInsAmtPer100K: 100n,
        btlUserAmtPer100K: 50n,
        btlBuyerAmtPer100K: 250n,
        btlProtocolAmtPer100K: 100n,
        btlRestrictBuyers: false,
      };

      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const result = await exchange.getLiquidationInfo(16n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getLiquidationInfo",
        args: [16n],
      });

      expect(result).toEqual(mockResult);
    });

    it("should preserve btlRestrictBuyers boolean", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue({
        liqInsAmtPer100K: 0n,
        liqUserAmtPer100K: 0n,
        liqProtocolAmtPer100K: 0n,
        btlPriceThreshPer100K: 0n,
        btlInsAmtPer100K: 0n,
        btlUserAmtPer100K: 0n,
        btlBuyerAmtPer100K: 0n,
        btlProtocolAmtPer100K: 0n,
        btlRestrictBuyers: true,
      });

      const result = await exchange.getLiquidationInfo(32n);
      expect(result.btlRestrictBuyers).toBe(true);
    });
  });

  // ============ getMarginFractions ============

  describe("getMarginFractions", () => {
    it("should return all 6 margin fields", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        1000n, // perpInitMarginFracHdths
        500n,  // perpMaintMarginFracHdths
        1200n, // dynamicInitMarginFracHdths
        50000000n, // oiMaxLNS
        8000n, // unityDescentThreshHdths
        12000n, // overColDescentThreshHdths
      ]);

      const result = await exchange.getMarginFractions(16n, 100000n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getMarginFractions",
        args: [16n, 100000n],
      });

      expect(result.perpInitMarginFracHdths).toBe(1000n);
      expect(result.perpMaintMarginFracHdths).toBe(500n);
      expect(result.dynamicInitMarginFracHdths).toBe(1200n);
      expect(result.oiMaxLNS).toBe(50000000n);
      expect(result.unityDescentThreshHdths).toBe(8000n);
      expect(result.overColDescentThreshHdths).toBe(12000n);
    });
  });

  // ============ getFundingInterval ============

  describe("getFundingInterval", () => {
    it("should return funding interval in blocks", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(57600n);

      const result = await exchange.getFundingInterval();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getFundingInterval",
      });

      expect(result).toBe(57600n);
    });
  });

  // ============ getFundingSumAtBlock ============

  describe("getFundingSumAtBlock", () => {
    it("should return funding sum and event block", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        123456789n,
        1000000n,
      ]);

      const result = await exchange.getFundingSumAtBlock(16n, 999999n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getFundingSumAtBlock",
        args: [16n, 999999n],
      });

      expect(result.fundingSumPNS).toBe(123456789n);
      expect(result.fundingEventBlock).toBe(1000000n);
    });
  });

  // ============ getPositionIds ============

  describe("getPositionIds", () => {
    it("should return start and end node IDs", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        1n,
        42n,
      ]);

      const result = await exchange.getPositionIds(16n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getPositionIds",
        args: [16n],
      });

      expect(result.startNodeId).toBe(1n);
      expect(result.endNodeId).toBe(42n);
    });
  });

  // ============ numberOfAccounts ============

  describe("numberOfAccounts", () => {
    it("should return total account count", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(1500n);

      const result = await exchange.numberOfAccounts();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "numberOfAccounts",
      });

      expect(result).toBe(1500n);
    });
  });

  // ============ getMinAccountOpenCNS ============

  describe("getMinAccountOpenCNS", () => {
    it("should return minimum collateral for account creation", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(10000000n); // 10 USDC

      const result = await exchange.getMinAccountOpenCNS();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getMinAccountOpenCNS",
      });

      expect(result).toBe(10000000n);
    });
  });

  // ============ getMinimumPostCNS ============

  describe("getMinimumPostCNS", () => {
    it("should return minimum order post value", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(1000000n); // 1 USDC

      const result = await exchange.getMinimumPostCNS();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getMinimumPostCNS",
      });

      expect(result).toBe(1000000n);
    });
  });

  // ============ getRecycleFeeCNS ============

  describe("getRecycleFeeCNS", () => {
    it("should return recycle fee amount", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(500000n);

      const result = await exchange.getRecycleFeeCNS();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getRecycleFeeCNS",
      });

      expect(result).toBe(500000n);
    });
  });

  // ============ isHalted ============

  describe("isHalted", () => {
    it("should return false when not halted", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const result = await exchange.isHalted();

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "isHalted",
      });

      expect(result).toBe(false);
    });

    it("should return true when halted", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await exchange.isHalted();
      expect(result).toBe(true);
    });
  });

  // ============ getOrderLocks ============

  describe("getOrderLocks", () => {
    it("should return and convert order locks", async () => {
      const mockLocks = [
        {
          orderLockId: 1n,
          nextOrderLockId: 2n,
          prevOrderLockId: 0n,
          orderType: 0n,
          lotLNS: 100000n,
          amountCNS: 5000000n,
        },
        {
          orderLockId: 2n,
          nextOrderLockId: 0n,
          prevOrderLockId: 1n,
          orderType: 1n,
          lotLNS: 200000n,
          amountCNS: 10000000n,
        },
      ];

      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(mockLocks);

      const result = await exchange.getOrderLocks(5n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getOrderLocks",
        args: [5n],
      });

      expect(result).toHaveLength(2);
      expect(result[0].orderLockId).toBe(1);
      expect(result[0].nextOrderLockId).toBe(2);
      expect(result[0].prevOrderLockId).toBe(0);
      expect(result[0].orderType).toBe(0);
      expect(result[0].lotLNS).toBe(100000n);
      expect(result[0].amountCNS).toBe(5000000n);
      expect(result[1].orderLockId).toBe(2);
    });

    it("should handle empty order locks", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await exchange.getOrderLocks(5n);
      expect(result).toHaveLength(0);
    });
  });

  // ============ getPerpOrderLocks ============

  describe("getPerpOrderLocks", () => {
    it("should pass both accountId and perpId", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await exchange.getPerpOrderLocks(5n, 16n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getPerpOrderLocks",
        args: [5n, 16n],
      });
    });
  });

  // ============ getWithdrawAllowanceData ============

  describe("getWithdrawAllowanceData", () => {
    it("should return all 4 fields", async () => {
      (mockClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([
        50000000n,  // allowanceCNS
        2000000n,   // expiryBlock
        1900000n,   // lastAllowanceBlock
        100n,       // cnsPerBlock
      ]);

      const result = await exchange.getWithdrawAllowanceData(1950000n);

      expect(mockClient.readContract).toHaveBeenCalledWith({
        address: EXCHANGE_ADDR,
        abi: expect.any(Array),
        functionName: "getWithdrawAllowanceData",
        args: [1950000n],
      });

      expect(result.allowanceCNS).toBe(50000000n);
      expect(result.expiryBlock).toBe(2000000n);
      expect(result.lastAllowanceBlock).toBe(1900000n);
      expect(result.cnsPerBlock).toBe(100n);
    });
  });
});
