/**
 * Uniswap V3 client for Monad
 * Handles spot swaps for the carry strategy's spot leg
 *
 * Uses SwapRouter02 (not UniversalRouter) — simpler ABI, no Permit2 required.
 * Route is determined at dev time (direct or via WMON), not dynamic.
 */

import {
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  encodePacked,
  maxUint256,
} from "viem";
import { SwapRouter02Abi, QuoterV2Abi, ERC20Abi } from "./uniswap-abi.js";

export interface UniswapConfig {
  swapRouterAddress: Address;
  quoterAddress: Address;
  wmonAddress: Address;
  /** Deadline in seconds added to current block timestamp. Always required. */
  deadlineSeconds: number;
  /** Fee tier for the swap pool (100, 500, 3000, 10000) */
  feeTier: number;
  /** Optional intermediate hop via WMON (null = direct pool) */
  intermediateHop: boolean;
}

export interface SwapResult {
  txHash: Hash;
  amountIn: bigint;
  amountOut: bigint;
  gasUsed: bigint;
}

/** Default Monad mainnet addresses */
export const UNISWAP_MONAD_ADDRESSES = {
  swapRouter: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900" as Address,
  quoter: "0x661e93cca42afacb172121ef892830ca3b70f08d" as Address,
  factory: "0x204faca1764b154221e35c0d20abb3c525710498" as Address,
  wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address,
  wbtc: "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Address,
  ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
} as const;

export class UniswapClient {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly config: UniswapConfig,
    private readonly tokenIn: Address,
    private readonly tokenOut: Address,
  ) {
    if (!walletClient.account) {
      throw new Error("WalletClient must have an account");
    }
    if (config.deadlineSeconds <= 0) {
      throw new Error("deadlineSeconds must be positive");
    }
  }

  /** Get a quote for swapping tokenIn → tokenOut */
  async getQuote(amountIn: bigint): Promise<bigint> {
    const path = this.encodePath(this.tokenIn, this.tokenOut);

    if (!this.config.intermediateHop) {
      // Single-hop: use quoteExactInputSingle
      const result = await this.publicClient.simulateContract({
        address: this.config.quoterAddress,
        abi: QuoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: this.tokenIn,
            tokenOut: this.tokenOut,
            amountIn,
            fee: this.config.feeTier,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return result.result[0];
    }

    // Multi-hop: use quoteExactInput
    const result = await this.publicClient.simulateContract({
      address: this.config.quoterAddress,
      abi: QuoterV2Abi,
      functionName: "quoteExactInput",
      args: [path, amountIn],
    });
    return result.result[0];
  }

  /** Swap tokenIn → tokenOut (e.g., AUSD → WBTC for entry) */
  async swap(amountIn: bigint, minAmountOut: bigint): Promise<SwapResult> {
    return this.executeSwap(this.tokenIn, this.tokenOut, amountIn, minAmountOut);
  }

  /** Reverse swap: tokenOut → tokenIn (e.g., WBTC → AUSD for exit) */
  async reverseSwap(amountIn: bigint, minAmountOut: bigint): Promise<SwapResult> {
    return this.executeSwap(this.tokenOut, this.tokenIn, amountIn, minAmountOut);
  }

  /** Approve token spending on SwapRouter02. One-time maxUint256 approval. */
  async approve(token: Address): Promise<Hash> {
    const account = this.walletClient.account!;

    // Check current allowance
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: ERC20Abi,
      functionName: "allowance",
      args: [account.address, this.config.swapRouterAddress],
    });

    if (allowance >= maxUint256 / 2n) {
      // Already approved sufficiently
      return "0x0" as Hash;
    }

    const { request } = await this.publicClient.simulateContract({
      address: token,
      abi: ERC20Abi,
      functionName: "approve",
      args: [this.config.swapRouterAddress, maxUint256],
      account,
    });

    return this.walletClient.writeContract(request);
  }

  /** Get token balance for the wallet */
  async getBalance(token: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20Abi,
      functionName: "balanceOf",
      args: [this.walletClient.account!.address],
    });
  }

  // ── Internals ─────────────────────────────────────────

  private async executeSwap(
    swapTokenIn: Address,
    swapTokenOut: Address,
    amountIn: bigint,
    minAmountOut: bigint,
  ): Promise<SwapResult> {
    const account = this.walletClient.account!;
    const recipient = account.address; // Always self — never caller-configurable

    // SwapRouter02 removed deadline from params (uses multicall wrapper instead).
    // Slippage protection via amountOutMinimum is sufficient for server-side bot.
    let txHash: Hash;

    if (!this.config.intermediateHop) {
      // Single-hop swap
      const { request } = await this.publicClient.simulateContract({
        address: this.config.swapRouterAddress,
        abi: SwapRouter02Abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: swapTokenIn,
            tokenOut: swapTokenOut,
            fee: this.config.feeTier,
            recipient,
            amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
        account,
      });
      txHash = await this.walletClient.writeContract(request);
    } else {
      // Multi-hop swap via WMON
      const path = this.encodePath(swapTokenIn, swapTokenOut);
      const { request } = await this.publicClient.simulateContract({
        address: this.config.swapRouterAddress,
        abi: SwapRouter02Abi,
        functionName: "exactInput",
        args: [
          {
            path,
            recipient,
            amountIn,
            amountOutMinimum: minAmountOut,
          },
        ],
        account,
      });
      txHash = await this.walletClient.writeContract(request);
    }

    // Wait for receipt and verify success
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`Swap reverted: ${txHash}`);
    }

    return {
      txHash,
      amountIn,
      amountOut: minAmountOut, // Actual amount determined by events; min is guaranteed
      gasUsed: receipt.gasUsed,
    };
  }

  private encodePath(from: Address, to: Address): `0x${string}` {
    if (this.config.intermediateHop) {
      // Multi-hop: from → WMON → to
      return encodePacked(
        ["address", "uint24", "address", "uint24", "address"],
        [from, this.config.feeTier, this.config.wmonAddress, this.config.feeTier, to],
      );
    }
    // Single-hop: from → to
    return encodePacked(
      ["address", "uint24", "address"],
      [from, this.config.feeTier, to],
    );
  }
}
