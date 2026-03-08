/**
 * Carry command — Delta-neutral funding rate carry trading
 *
 * Commands:
 *   carry start  — Start carry bot (blocks, handles SIGINT)
 *   carry status — Current metrics (read-only)
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  loadEnvConfig,
  validateConfig,
  Wallet,
  Exchange,
  Portfolio,
  PERPETUALS,
} from "../sdk/index.js";
import { UniswapClient, UNISWAP_MONAD_ADDRESSES } from "../sdk/integrations/uniswap.js";
import { CarryStrategy, type CarryConfig, type CarryMetrics } from "../sdk/trading/strategies/carry.js";

const PERP_NAMES: Record<string, bigint> = {
  btc: PERPETUALS.BTC,
  eth: PERPETUALS.ETH,
  sol: PERPETUALS.SOL,
  mon: PERPETUALS.MON,
  zec: PERPETUALS.ZEC,
};

function resolvePerpId(perp: string): bigint {
  const lower = perp.toLowerCase();
  if (PERP_NAMES[lower] !== undefined) return PERP_NAMES[lower];
  const parsed = parseInt(perp, 10);
  if (!isNaN(parsed)) return BigInt(parsed);
  throw new Error(`Unknown perpetual: ${perp}`);
}

export function registerCarryCommand(program: Command): void {
  const carry = program
    .command("carry")
    .description("Delta-neutral funding rate carry trading");

  // ── carry start ──────────────────────────────────

  carry
    .command("start")
    .description("Start carry bot (blocks, handles SIGINT/SIGTERM)")
    .requiredOption("--perp <name>", "Perpetual to carry (btc, eth, sol, mon, zec)")
    .requiredOption("--capital <usd>", "Total capital in USD")
    .option("--leverage <n>", "Perp leverage multiplier", "2")
    .option("--entry-threshold <pct>", "Min APY to enter (e.g. 0.05 = 5%)", "0.05")
    .option("--exit-threshold <pct>", "APY to exit (e.g. 0.01 = 1%)", "0.01")
    .option("--db <path>", "Database path", "./data/carry.db")
    .option("--fee-tier <bps>", "Uniswap fee tier (500, 3000, 10000)", "3000")
    .option("--via-wmon", "Route through WMON (multi-hop)")
    .action(async (options) => {
      const config = loadEnvConfig();
      validateConfig(config);

      const wallet = Wallet.fromPrivateKey(config.privateKey, config.chain);
      const exchange = new Exchange(
        config.chain.exchangeAddress,
        wallet.publicClient,
        wallet.walletClient,
      );

      // Get account ID
      const accountInfo = await exchange.getAccountByAddress(wallet.address);
      if (!accountInfo || accountInfo.accountId === 0n) {
        console.error("No exchange account found. Run 'manage deposit' first.");
        process.exit(1);
      }

      const portfolio = new Portfolio(
        exchange,
        wallet.publicClient,
        config.chain.exchangeAddress,
      );
      await portfolio.setAccountByAddress(wallet.address);

      const perpId = resolvePerpId(options.perp);

      const uniswap = new UniswapClient(
        wallet.publicClient,
        wallet.walletClient,
        {
          swapRouterAddress: UNISWAP_MONAD_ADDRESSES.swapRouter,
          quoterAddress: UNISWAP_MONAD_ADDRESSES.quoter,
          wmonAddress: UNISWAP_MONAD_ADDRESSES.wmon,
          deadlineSeconds: 120,
          feeTier: parseInt(options.feeTier, 10),
          intermediateHop: options.viaWmon ?? false,
        },
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const carryConfig: CarryConfig = {
        perpId,
        spotTokenIn: UNISWAP_MONAD_ADDRESSES.ausd,
        spotTokenOut: UNISWAP_MONAD_ADDRESSES.wbtc,
        totalCapitalAusd: parseFloat(options.capital),
        perpLeverage: parseFloat(options.leverage),
        minFundingRateApy: parseFloat(options.entryThreshold),
        exitFundingRateApy: parseFloat(options.exitThreshold),
        databasePath: options.db,
      };

      console.log(chalk.bold("Carry Bot Configuration"));
      console.log(`  Perpetual: ${options.perp.toUpperCase()} (ID: ${perpId})`);
      console.log(`  Capital: $${carryConfig.totalCapitalAusd.toLocaleString()}`);
      console.log(`  Leverage: ${carryConfig.perpLeverage}x`);
      console.log(`  Entry Threshold: ${(carryConfig.minFundingRateApy * 100).toFixed(1)}% APY`);
      console.log(`  Exit Threshold: ${(carryConfig.exitFundingRateApy * 100).toFixed(1)}% APY`);
      console.log(`  Fee Tier: ${options.feeTier} bps`);
      console.log(`  Route: ${options.viaWmon ? "via WMON" : "direct"}`);
      console.log("");

      // Approve tokens before starting
      console.log("Approving tokens...");
      await uniswap.approve(UNISWAP_MONAD_ADDRESSES.ausd);
      await uniswap.approve(UNISWAP_MONAD_ADDRESSES.wbtc);
      console.log("Tokens approved.\n");

      const strategy = new CarryStrategy(
        carryConfig,
        exchange,
        uniswap,
        wallet.publicClient,
        portfolio,
        accountInfo.accountId,
      );

      try {
        await strategy.start();
      } finally {
        strategy.close();
      }
    });

  // ── carry status ─────────────────────────────────

  carry
    .command("status")
    .description("Show carry bot status and metrics")
    .option("--perp <name>", "Perpetual (default: btc)", "btc")
    .option("--db <path>", "Database path", "./data/carry.db")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const config = loadEnvConfig();
      validateConfig(config);

      const wallet = Wallet.fromPrivateKey(config.privateKey, config.chain);
      const exchange = new Exchange(
        config.chain.exchangeAddress,
        wallet.publicClient,
        wallet.walletClient,
      );

      const accountInfo = await exchange.getAccountByAddress(wallet.address);
      const portfolio = new Portfolio(
        exchange,
        wallet.publicClient,
        config.chain.exchangeAddress,
      );
      await portfolio.setAccountByAddress(wallet.address);

      const perpId = resolvePerpId(options.perp);

      const uniswap = new UniswapClient(
        wallet.publicClient,
        wallet.walletClient,
        {
          swapRouterAddress: UNISWAP_MONAD_ADDRESSES.swapRouter,
          quoterAddress: UNISWAP_MONAD_ADDRESSES.quoter,
          wmonAddress: UNISWAP_MONAD_ADDRESSES.wmon,
          deadlineSeconds: 120,
          feeTier: 3000,
          intermediateHop: false,
        },
        UNISWAP_MONAD_ADDRESSES.ausd,
        UNISWAP_MONAD_ADDRESSES.wbtc,
      );

      const strategy = new CarryStrategy(
        {
          perpId,
          spotTokenIn: UNISWAP_MONAD_ADDRESSES.ausd,
          spotTokenOut: UNISWAP_MONAD_ADDRESSES.wbtc,
          totalCapitalAusd: 1, // Dummy value — only getMetrics() is called
          perpLeverage: 2,
          minFundingRateApy: 0.05,
          exitFundingRateApy: 0.01,
          databasePath: options.db,
        },
        exchange,
        uniswap,
        wallet.publicClient,
        portfolio,
        accountInfo.accountId,
      );

      try {
        const metrics = await strategy.getMetrics();

        if (options.json) {
          console.log(JSON.stringify(metrics, null, 2));
          return;
        }

        printStatus(metrics);
      } finally {
        strategy.close();
      }
    });
}

// ── Status Display ─────────────────────────────────

function printStatus(m: CarryMetrics): void {
  const sep = chalk.dim("─".repeat(44));

  console.log(chalk.bold("\nCarry Bot Status"));
  console.log(sep);

  const phaseColor =
    m.phase === "active" ? chalk.green : m.phase === "idle" ? chalk.dim : chalk.yellow;
  const runningStr = m.runningForMs
    ? formatDuration(m.runningForMs)
    : "";

  console.log(`Phase:              ${phaseColor(m.phase.toUpperCase())}${runningStr ? ` (running ${runningStr})` : ""}`);
  console.log(`BTC Funding Rate:   ${formatPct(m.fundingRateApy)} APY`);
  console.log(`Delta Exposure:     ${formatPct(m.deltaExposurePct)}`);
  console.log("");

  if (m.phase !== "idle") {
    console.log(chalk.bold("Perp Leg:"));
    console.log(`  Side:             Short`);
    console.log(`  Size:             ${m.perpSizeBtc.toFixed(4)} BTC @ $${m.perpEntryPrice.toFixed(0)} avg`);
    console.log(`  Margin:           $${m.perpMarginUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log("");

    console.log(chalk.bold("Spot Leg:"));
    console.log(`  WBTC Held:        ${m.spotSizeBtc.toFixed(4)} BTC`);
    console.log(`  Value:            $${m.spotValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log("");

    console.log(chalk.bold("PnL Breakdown:"));
    console.log(`  Funding Earned:   ${colorPnl(m.fundingEarnedUsd)}`);
    console.log(`  Costs:            ${chalk.red(`-$${m.costsUsd.toFixed(2)}`)}`);
    console.log(`  Net PnL:          ${colorPnl(m.netPnlUsd)}`);
    console.log(`  Net APY:          ${formatPct(m.netApyPct)}`);
    console.log("");
  }

  console.log(`Reserve:            $${m.reserveUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(sep);
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

function formatPct(v: number): string {
  const str = `${(v * 100).toFixed(1)}%`;
  return v >= 0 ? chalk.green(str) : chalk.red(str);
}

function colorPnl(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return v >= 0
    ? chalk.green(`${sign}$${v.toFixed(2)}`)
    : chalk.red(`${sign}$${v.toFixed(2)}`);
}
