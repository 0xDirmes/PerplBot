import "dotenv/config";
import { createPublicClient, http } from "viem";
import { getChainConfig } from "../src/sdk/config.js";
import { UNISWAP_MONAD_ADDRESSES } from "../src/sdk/integrations/uniswap.js";

const chainConfig = getChainConfig();
const client = createPublicClient({ chain: chainConfig.chain, transport: http(chainConfig.rpcUrl) });

const pool = await client.readContract({
  address: UNISWAP_MONAD_ADDRESSES.factory as `0x${string}`,
  abi: [{
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "fee", type: "uint24" }],
    outputs: [{ name: "pool", type: "address" }],
  }] as const,
  functionName: "getPool",
  args: [UNISWAP_MONAD_ADDRESSES.wmon, UNISWAP_MONAD_ADDRESSES.ausd, 500],
});

console.log("Pool address:", pool);
console.log(`\nUniswap app: https://app.uniswap.org/explore/pools/monad/${pool}`);
console.log(`MonadScan:   https://monadexplorer.com/address/${pool}`);
