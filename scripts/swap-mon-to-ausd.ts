/**
 * Swap MON → WMON → AUSD via Uniswap V3
 * Usage: npx tsx scripts/swap-mon-to-ausd.ts <amount_mon>
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { UNISWAP_MONAD_ADDRESSES } from "../src/sdk/integrations/uniswap.js";
import { QuoterV2Abi, ERC20Abi } from "../src/sdk/integrations/uniswap-abi.js";
import { UniswapClient } from "../src/sdk/integrations/uniswap.js";
import { getChainConfig, getPrivateKey } from "../src/sdk/config.js";

const WMON_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

async function main() {
  const amountMon = process.argv[2] ?? "5";
  const amountWei = parseEther(amountMon);

  const chainConfig = getChainConfig();
  const privateKey = getPrivateKey();
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: chainConfig.chain,
    transport: http(chainConfig.rpcUrl),
  });

  console.log(`Wallet: ${account.address}`);
  console.log(`Network: ${chainConfig.chain.name} (${chainConfig.chain.id})`);
  console.log(`Swapping ${amountMon} MON → WMON → AUSD\n`);

  // Step 1: Check MON balance
  const monBalance = await publicClient.getBalance({ address: account.address });
  console.log(`MON balance: ${formatUnits(monBalance, 18)}`);
  if (monBalance < amountWei) {
    console.error(`Insufficient MON. Have ${formatUnits(monBalance, 18)}, need ${amountMon}`);
    process.exit(1);
  }

  // Step 2: Get quote first (WMON → AUSD)
  console.log("\nGetting quote for WMON → AUSD...");
  try {
    const quoteResult = await publicClient.simulateContract({
      address: UNISWAP_MONAD_ADDRESSES.quoter,
      abi: QuoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: UNISWAP_MONAD_ADDRESSES.wmon,
          tokenOut: UNISWAP_MONAD_ADDRESSES.ausd,
          amountIn: amountWei,
          fee: 3000,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const expectedAusd = quoteResult.result[0];
    // AUSD has 6 decimals (standard USD stablecoin)
    console.log(`Quote: ${amountMon} MON → ${formatUnits(expectedAusd, 6)} AUSD`);
    console.log(`Rate: 1 MON ≈ ${formatUnits(expectedAusd * BigInt(10 ** 12) / amountWei, 6)} AUSD\n`);
  } catch (err) {
    console.error("Quote failed — WMON/AUSD pool may not exist at fee tier 3000.");
    console.error("Trying fee tier 500...");
    try {
      const quoteResult = await publicClient.simulateContract({
        address: UNISWAP_MONAD_ADDRESSES.quoter,
        abi: QuoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: UNISWAP_MONAD_ADDRESSES.wmon,
            tokenOut: UNISWAP_MONAD_ADDRESSES.ausd,
            amountIn: amountWei,
            fee: 500,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const expectedAusd = quoteResult.result[0];
      console.log(`Quote (500 bps): ${amountMon} MON → ${formatUnits(expectedAusd, 6)} AUSD`);
      console.log(`Rate: 1 MON ≈ ${formatUnits(expectedAusd * BigInt(10 ** 12) / amountWei, 6)} AUSD\n`);
    } catch {
      console.error("Quote also failed at 500 bps. Trying 10000...");
      try {
        const quoteResult = await publicClient.simulateContract({
          address: UNISWAP_MONAD_ADDRESSES.quoter,
          abi: QuoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: UNISWAP_MONAD_ADDRESSES.wmon,
              tokenOut: UNISWAP_MONAD_ADDRESSES.ausd,
              amountIn: amountWei,
              fee: 10000,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const expectedAusd = quoteResult.result[0];
        console.log(`Quote (10000 bps): ${amountMon} MON → ${formatUnits(expectedAusd, 6)} AUSD`);
      } catch {
        console.error("\nNo WMON/AUSD pool found at any fee tier.");
        console.error("You may need to swap via a DEX UI or bridge AUSD directly.");
        process.exit(1);
      }
    }
  }

  // Step 3: Wrap MON → WMON (skip if already have enough)
  const existingWmon = await publicClient.readContract({
    address: UNISWAP_MONAD_ADDRESSES.wmon,
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (existingWmon >= amountWei) {
    console.log(`Already have ${formatUnits(existingWmon, 18)} WMON, skipping wrap.`);
  } else {
    const wrapAmount = amountWei - existingWmon;
    console.log(`Wrapping ${formatUnits(wrapAmount, 18)} MON → WMON...`);
    const wrapHash = await walletClient.writeContract({
      address: UNISWAP_MONAD_ADDRESSES.wmon,
      abi: WMON_ABI,
      functionName: "deposit",
      value: wrapAmount,
    });
    const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapHash, timeout: 60_000 });
    if (wrapReceipt.status !== "success") {
      console.error("WMON wrap failed!");
      process.exit(1);
    }
    console.log(`Wrapped: ${wrapHash}`);
  }

  // Step 4: Approve WMON to SwapRouter
  console.log("Approving WMON to SwapRouter...");
  const uniswap = new UniswapClient(
    publicClient,
    walletClient,
    {
      swapRouterAddress: UNISWAP_MONAD_ADDRESSES.swapRouter,
      quoterAddress: UNISWAP_MONAD_ADDRESSES.quoter,
      wmonAddress: UNISWAP_MONAD_ADDRESSES.wmon,
      deadlineSeconds: 120,
      feeTier: 500,  // WMON/AUSD pool is at 500 bps (0.05%)
      intermediateHop: false,
    },
    UNISWAP_MONAD_ADDRESSES.wmon,  // tokenIn = WMON
    UNISWAP_MONAD_ADDRESSES.ausd,  // tokenOut = AUSD
  );
  await uniswap.approve(UNISWAP_MONAD_ADDRESSES.wmon);
  console.log("WMON approved.");

  // Step 5: Swap WMON → AUSD
  console.log("\nSwapping WMON → AUSD...");
  // Check WMON balance (may already be wrapped from previous run)
  const wmonBalance = await publicClient.readContract({
    address: UNISWAP_MONAD_ADDRESSES.wmon,
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const swapAmount = wmonBalance < amountWei ? wmonBalance : amountWei;
  console.log(`WMON available: ${formatUnits(wmonBalance, 18)}`);

  // Use 2% slippage for safety (unknown liquidity depth)
  const quote = await uniswap.getQuote(swapAmount);
  const minOut = quote * 98n / 100n;
  console.log(`Expected: ${formatUnits(quote, 6)} AUSD (min: ${formatUnits(minOut, 6)})`);

  const result = await uniswap.swap(swapAmount, minOut);
  console.log(`\nSwap complete!`);
  console.log(`  TX: ${result.txHash}`);
  console.log(`  AUSD received: ${formatUnits(result.amountOut, 6)}`);
  console.log(`  Gas used: ${result.gasUsed}`);

  // Step 6: Check final balances
  const ausdBalance = await publicClient.readContract({
    address: UNISWAP_MONAD_ADDRESSES.ausd,
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const finalMon = await publicClient.getBalance({ address: account.address });
  console.log(`\nFinal balances:`);
  console.log(`  MON: ${formatUnits(finalMon, 18)}`);
  console.log(`  AUSD: ${formatUnits(ausdBalance, 6)}`);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
