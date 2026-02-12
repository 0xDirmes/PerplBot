/**
 * Unit tests for Exchange error decoding utility
 * Tests: decodeExchangeError, formatExchangeError, decodeExchangeErrorString
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, encodeErrorResult, type Hex } from "viem";
import { ExchangeAbi } from "../../src/sdk/contracts/abi.js";
import {
  decodeExchangeError,
  formatExchangeError,
  decodeExchangeErrorString,
  type DecodedExchangeError,
} from "../../src/sdk/contracts/errors.js";

describe("Exchange error decoding", () => {
  // ============ decodeExchangeError ============

  describe("decodeExchangeError", () => {
    it("should decode a no-arg error (ExchangeHalted)", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "ExchangeHalted",
      });

      const result = decodeExchangeError(encoded);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("ExchangeHalted");
      expect(Object.keys(result!.args)).toHaveLength(0);
    });

    it("should decode an error with uint256 params (InsufficientFunds)", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "InsufficientFunds",
        args: [1000000n, 2000000n],
      });

      const result = decodeExchangeError(encoded);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("InsufficientFunds");
      // BigInts are converted to strings
      expect(result!.args.balanceCNS).toBe("1000000");
      expect(result!.args.amountCNS).toBe("2000000");
    });

    it("should decode an error with bool param (CrossesBook)", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "CrossesBook",
        args: [16n, 5n, 50000n, true, 49000n, false],
      });

      const result = decodeExchangeError(encoded);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("CrossesBook");
      expect(result!.args.perpId).toBe("16");
      expect(result!.args.accountId).toBe("5");
      expect(result!.args.isBid).toBe(true);
      expect(result!.args.maxOrdersChecked).toBe(false);
    });

    it("should decode ContractIsPaused error", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "ContractIsPaused",
        args: [32n],
      });

      const result = decodeExchangeError(encoded);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("ContractIsPaused");
      expect(result!.args.perpId).toBe("32");
    });

    it("should return null for unknown error selector", () => {
      // Random 4-byte selector that doesn't match any error
      const unknownData = "0xdeadbeef" as Hex;
      const result = decodeExchangeError(unknownData);
      expect(result).toBeNull();
    });

    it("should return null for empty data", () => {
      const result = decodeExchangeError("0x" as Hex);
      expect(result).toBeNull();
    });

    it("should return null for malformed data", () => {
      const result = decodeExchangeError("0x1234" as Hex);
      expect(result).toBeNull();
    });
  });

  // ============ formatExchangeError ============

  describe("formatExchangeError", () => {
    it("should format error with no args", () => {
      const error: DecodedExchangeError = {
        name: "ExchangeHalted",
        args: {},
      };
      expect(formatExchangeError(error)).toBe("ExchangeHalted");
    });

    it("should format error with args", () => {
      const error: DecodedExchangeError = {
        name: "InsufficientFunds",
        args: { balanceCNS: "1000000", amountCNS: "2000000" },
      };
      expect(formatExchangeError(error)).toBe(
        "InsufficientFunds(balanceCNS=1000000, amountCNS=2000000)",
      );
    });

    it("should format error with boolean args", () => {
      const error: DecodedExchangeError = {
        name: "CrossesBook",
        args: { perpId: "16", isBid: true },
      };
      expect(formatExchangeError(error)).toBe("CrossesBook(perpId=16, isBid=true)");
    });
  });

  // ============ decodeExchangeErrorString ============

  describe("decodeExchangeErrorString", () => {
    it("should return formatted string for known error", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "ExchangeHalted",
      });

      const result = decodeExchangeErrorString(encoded);
      expect(result).toBe("ExchangeHalted");
    });

    it("should return formatted string with params for known error", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "ContractIsPaused",
        args: [16n],
      });

      const result = decodeExchangeErrorString(encoded);
      expect(result).toBe("ContractIsPaused(perpId=16)");
    });

    it("should return raw hex for unknown error", () => {
      const unknown = "0xdeadbeef" as Hex;
      const result = decodeExchangeErrorString(unknown);
      expect(result).toBe("Unknown error: 0xdeadbeef");
    });

    it("should handle error with many params", () => {
      const encoded = encodeErrorResult({
        abi: ExchangeAbi,
        errorName: "PriceOutOfRange",
        args: [50000n, 10000n, 100000n],
      });

      const result = decodeExchangeErrorString(encoded);
      expect(result).toBe(
        "PriceOutOfRange(pricePNS=50000, minPricePNS=10000, maxPricePNS=100000)",
      );
    });
  });
});
