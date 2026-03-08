/**
 * Tests for transaction receipt verification utility
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, Hash, PublicClient, TransactionReceipt } from "viem";
import {
  Exchange,
  waitForTransactionSuccess,
} from "../../src/sdk/contracts/Exchange.js";

const EXCHANGE_ADDR = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" as Address;
const TX_HASH = "0xabc123" as Hash;

function createMockPublicClient() {
  return {
    readContract: vi.fn(),
    getBlockNumber: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    chain: { id: 10143 },
  } as unknown as PublicClient;
}

describe("waitForTransactionSuccess", () => {
  let mockClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    mockClient = createMockPublicClient();
  });

  it("should return receipt when transaction succeeds", async () => {
    const receipt = { status: "success", transactionHash: TX_HASH } as unknown as TransactionReceipt;
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(receipt);

    const result = await waitForTransactionSuccess(mockClient, TX_HASH);
    expect(result).toBe(receipt);
    expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
      timeout: 60_000,
    });
  });

  it("should throw when transaction reverts", async () => {
    const receipt = { status: "reverted", transactionHash: TX_HASH } as unknown as TransactionReceipt;
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(receipt);

    await expect(waitForTransactionSuccess(mockClient, TX_HASH)).rejects.toThrow(
      `Transaction reverted: ${TX_HASH}`
    );
  });

  it("should respect custom timeout", async () => {
    const receipt = { status: "success", transactionHash: TX_HASH } as unknown as TransactionReceipt;
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(receipt);

    await waitForTransactionSuccess(mockClient, TX_HASH, 30_000);
    expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
      timeout: 30_000,
    });
  });

  it("should propagate RPC errors", async () => {
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("RPC timeout")
    );

    await expect(waitForTransactionSuccess(mockClient, TX_HASH)).rejects.toThrow("RPC timeout");
  });
});

describe("Exchange.waitForReceipt", () => {
  let exchange: Exchange;
  let mockClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    mockClient = createMockPublicClient();
    exchange = new Exchange(EXCHANGE_ADDR, mockClient);
  });

  it("should delegate to waitForTransactionSuccess", async () => {
    const receipt = { status: "success", transactionHash: TX_HASH } as unknown as TransactionReceipt;
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(receipt);

    const result = await exchange.waitForReceipt(TX_HASH);
    expect(result).toBe(receipt);
  });

  it("should throw on reverted transaction", async () => {
    const receipt = { status: "reverted", transactionHash: TX_HASH } as unknown as TransactionReceipt;
    (mockClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(receipt);

    await expect(exchange.waitForReceipt(TX_HASH)).rejects.toThrow("Transaction reverted");
  });
});
