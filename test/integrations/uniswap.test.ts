/**
 * Tests for Uniswap V3 client
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UniswapClient, type UniswapConfig, UNISWAP_MONAD_ADDRESSES } from "../../src/sdk/integrations/uniswap.js";
import type { Address, PublicClient, WalletClient } from "viem";

// Mock clients
function createMockPublicClient() {
  return {
    simulateContract: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getBlock: vi.fn(),
  } as unknown as PublicClient;
}

function createMockWalletClient() {
  return {
    account: {
      address: "0x1234567890abcdef1234567890abcdef12345678" as Address,
    },
    writeContract: vi.fn(),
  } as unknown as WalletClient;
}

const defaultConfig: UniswapConfig = {
  swapRouterAddress: UNISWAP_MONAD_ADDRESSES.swapRouter,
  quoterAddress: UNISWAP_MONAD_ADDRESSES.quoter,
  wmonAddress: UNISWAP_MONAD_ADDRESSES.wmon,
  deadlineSeconds: 120,
  feeTier: 3000,
  intermediateHop: false,
};

describe("UniswapClient", () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
  });

  describe("constructor", () => {
    it("throws if walletClient has no account", () => {
      const noAccount = { ...walletClient, account: undefined } as unknown as WalletClient;
      expect(
        () =>
          new UniswapClient(
            publicClient as unknown as PublicClient,
            noAccount,
            defaultConfig,
            UNISWAP_MONAD_ADDRESSES.ausd,
            UNISWAP_MONAD_ADDRESSES.wbtc,
          ),
      ).toThrow("WalletClient must have an account");
    });

    it("throws if deadlineSeconds is not positive", () => {
      expect(
        () =>
          new UniswapClient(
            publicClient as unknown as PublicClient,
            walletClient as unknown as WalletClient,
            { ...defaultConfig, deadlineSeconds: 0 },
            UNISWAP_MONAD_ADDRESSES.ausd,
            UNISWAP_MONAD_ADDRESSES.wbtc,
          ),
      ).toThrow("deadlineSeconds must be positive");
    });

    it("creates successfully with valid params", () => {
      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );
      expect(client).toBeDefined();
    });
  });

  describe("getQuote", () => {
    it("calls quoteExactInputSingle for single-hop", async () => {
      (publicClient.simulateContract as any).mockResolvedValue({
        result: [1000000n, 0n, 0, 0n], // amountOut, sqrtPriceAfter, ticks, gas
      });

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const quote = await client.getQuote(1000000n);
      expect(quote).toBe(1000000n);

      expect(publicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: defaultConfig.quoterAddress,
          functionName: "quoteExactInputSingle",
        }),
      );
    });

    it("calls quoteExactInput for multi-hop", async () => {
      (publicClient.simulateContract as any).mockResolvedValue({
        result: [500000n, [], [], 0n],
      });

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        { ...defaultConfig, intermediateHop: true },
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const quote = await client.getQuote(1000000n);
      expect(quote).toBe(500000n);

      expect(publicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "quoteExactInput",
        }),
      );
    });
  });

  describe("swap", () => {
    it("executes single-hop swap and verifies receipt", async () => {
      (publicClient.simulateContract as any).mockResolvedValue({
        request: { to: defaultConfig.swapRouterAddress },
      });
      (walletClient.writeContract as any).mockResolvedValue("0xabc123");
      (publicClient.waitForTransactionReceipt as any).mockResolvedValue({
        status: "success",
        gasUsed: 150000n,
      });

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const result = await client.swap(1000000n, 900000n);
      expect(result.txHash).toBe("0xabc123");
      expect(result.gasUsed).toBe(150000n);

      // Verify receipt was checked
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: "0xabc123",
        timeout: 60_000,
      });
    });

    it("throws on reverted swap", async () => {
      (publicClient.simulateContract as any).mockResolvedValue({
        request: { to: defaultConfig.swapRouterAddress },
      });
      (walletClient.writeContract as any).mockResolvedValue("0xfailed");
      (publicClient.waitForTransactionReceipt as any).mockResolvedValue({
        status: "reverted",
        gasUsed: 50000n,
      });

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      await expect(client.swap(1000000n, 900000n)).rejects.toThrow("Swap reverted");
    });
  });

  describe("approve", () => {
    it("skips approval if already approved", async () => {
      // Return a very large allowance
      (publicClient.readContract as any).mockResolvedValue(
        BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
      );

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const hash = await client.approve(UNISWAP_MONAD_ADDRESSES.ausd);
      expect(hash).toBe("0x0");
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("approves if allowance is low", async () => {
      (publicClient.readContract as any).mockResolvedValue(0n);
      (publicClient.simulateContract as any).mockResolvedValue({
        request: { to: UNISWAP_MONAD_ADDRESSES.ausd },
      });
      (walletClient.writeContract as any).mockResolvedValue("0xapprove123");

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const hash = await client.approve(UNISWAP_MONAD_ADDRESSES.ausd);
      expect(hash).toBe("0xapprove123");
    });
  });

  describe("getBalance", () => {
    it("reads token balance", async () => {
      (publicClient.readContract as any).mockResolvedValue(50000000n); // 0.5 WBTC

      const client = new UniswapClient(
        publicClient as unknown as PublicClient,
        walletClient as unknown as WalletClient,
        defaultConfig,
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const balance = await client.getBalance(UNISWAP_MONAD_ADDRESSES.wbtc);
      expect(balance).toBe(50000000n);
    });
  });

  describe("addresses", () => {
    it("exports correct Monad mainnet addresses", () => {
      expect(UNISWAP_MONAD_ADDRESSES.swapRouter).toBe(
        "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
      );
      expect(UNISWAP_MONAD_ADDRESSES.quoter).toBe(
        "0x661e93cca42afacb172121ef892830ca3b70f08d",
      );
      expect(UNISWAP_MONAD_ADDRESSES.wbtc).toBe(
        "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
      );
      expect(UNISWAP_MONAD_ADDRESSES.ausd).toBe(
        "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
      );
    });
  });
});
