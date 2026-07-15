#!/usr/bin/env node
/** CLI for Polymarket monitor → redeem bot. */

import { resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "./config.js";
import {
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  INTERVAL_SECONDS,
  NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  RELAYER_URL,
  collateralAdapterAddress,
} from "./constants.js";
import { credentialsFromClobClient, probeUserWsAuth } from "./data/clobUserWs.js";
import { runAllMarkets } from "./engine.js";
import { ClobClient } from "./execution/clobClient.js";
import {
  ensureDepositWalletDeployed,
  resolveDepositWalletAddress,
} from "./execution/depositWallet.js";
import { paperSessionFromBotConfig, type PaperSessionLedger } from "./execution/paperExchange.js";
import { loadBuilderCredsPool } from "./execution/redeem.js";
import { RedeemScheduler } from "./execution/redeemScheduler.js";
import { installRunLogging } from "./logSetup.js";
import { describeSchedule, waitForTradingWindow } from "./schedule.js";
import type { Settings } from "./config.js";

function utcNow(): Date {
  return new Date();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runLoop(settings: Settings): Promise<void> {
  const lm = settings.liquidity_maker;
  const exe = settings.execution;

  const ctfAd = collateralAdapterAddress({
    negRisk: false,
    override: exe.ctf_collateral_adapter || "",
  });
  const negAd = collateralAdapterAddress({
    negRisk: true,
    override: exe.neg_risk_ctf_collateral_adapter || "",
  });
  console.log(`  CtfCollateralAdapter: ${ctfAd}`);
  console.log(`  NegRiskCtfCollateralAdapter: ${negAd}`);
  if (
    ctfAd.toLowerCase() !== CTF_COLLATERAL_ADAPTER_ADDRESS.toLowerCase() ||
    negAd.toLowerCase() !== NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS.toLowerCase()
  ) {
    console.log("  NOTE: custom adapter override(s) in effect");
  }

  let depositWalletAddress = "";
  if ((exe.private_key || "").trim()) {
    depositWalletAddress = resolveDepositWalletAddress({
      privateKey: exe.private_key,
      chainId: exe.chain_id,
      configuredFunder: exe.funder || "",
    });
    console.log(`  Deposit wallet: ${depositWalletAddress}`);
    if (
      !settings.bot.paper_trading &&
      !settings.bot.dry_run &&
      exe.auto_deploy_deposit_wallet !== false
    ) {
      const builderKey = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_KEY || "";
      const builderSecret = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_SECRET || "";
      const builderPassphrase = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_PASSPHRASE || "";
      if (builderKey && builderSecret && builderPassphrase) {
        try {
          const deployTx = await ensureDepositWalletDeployed({
            relayerUrl: RELAYER_URL,
            chainId: exe.chain_id,
            privateKey: exe.private_key,
            builderApiKey: builderKey,
            builderApiSecret: builderSecret,
            builderApiPassphrase: builderPassphrase,
            walletAddress: depositWalletAddress,
          });
          if (deployTx) {
            console.log(`  Deployed deposit wallet tx=${deployTx}`);
          }
        } catch (e) {
          console.log(`  WARNING: deposit wallet deploy check failed (${e})`);
        }
      } else {
        console.log("  WARNING: builder relayer creds missing; skipping deposit wallet deploy check");
      }
    }
  }

  let clobClient: ClobClient | null = null;
  let paperSession: PaperSessionLedger | null = null;
  if (settings.bot.paper_trading) {
    paperSession = paperSessionFromBotConfig(settings.bot);
    console.log(
      `  PAPER SESSION: bankroll=${paperSession.startingUsdc.toFixed(2)} USDC ` +
        `fee_bps=${paperSession.feeBps}`,
    );
  }

  if ((exe.private_key || "").trim() && !settings.bot.paper_trading) {
    try {
      clobClient = await ClobClient.create({
        privateKey: exe.private_key,
        apiKey: exe.api_key || process.env.POLYBOT5MBES_EXECUTION__API_KEY || "",
        apiSecret: exe.api_secret || process.env.POLYBOT5MBES_EXECUTION__API_SECRET || "",
        apiPassphrase: exe.api_passphrase || process.env.POLYBOT5MBES_EXECUTION__API_PASSPHRASE || "",
        host: settings.api.clob_url,
        chainId: exe.chain_id,
        signatureType: exe.signature_type ?? 3,
        funder: depositWalletAddress || exe.funder || "",
        deriveApiCreds: exe.derive_clob_api_creds !== false,
        rpcUrl: exe.rpc_url || "",
        builderCode: (exe.builder_code || process.env.POLYBOT5MBES_EXECUTION__BUILDER_CODE || "").trim(),
      });
    } catch (e) {
      console.log(`  WARNING: CLOB client init failed (${e}); neg_risk/allowance sync disabled`);
    }

    if (
      clobClient &&
      !(clobClient.apiKey && clobClient.apiSecret && clobClient.apiPassphrase)
    ) {
      console.log(
        "  WARNING: CLOB API creds missing after init — user WebSocket will fail. " +
          "Set POLYBOT5MBES_EXECUTION__API_KEY/SECRET/PASSPHRASE in .env or fix derive_clob_api_creds.",
      );
    } else if (clobClient && lm.monitor_user_ws_enabled !== false && !settings.bot.paper_trading) {
      const wsAuth = credentialsFromClobClient(clobClient);
      if (!wsAuth) {
        console.log("  WARNING: cannot probe user WebSocket — no CLOB API creds on client");
      } else {
        const [ok, detail] = await probeUserWsAuth(wsAuth, { wsUrl: settings.api.ws_url });
        if (ok) {
          console.log(`  user WebSocket probe OK (${detail})`);
        } else {
          console.log(
            `  WARNING: user WebSocket probe FAILED: ${detail}. ` +
              "Refresh POLYBOT5MBES_EXECUTION__API_* from the same wallet as PRIVATE_KEY.",
          );
        }
      }
    }
  }

  if (!settings.bot.paper_trading && lm.redeem_enabled !== false) {
    const pool = loadBuilderCredsPool();
    if (!pool.length) {
      console.log(
        "  WARNING: no builder relayer creds — redeem will fail. " +
          "Set POLYBOT5MBES_EXECUTION__BUILDER_API_KEY/SECRET/PASSPHRASE.",
      );
    } else if ((exe.private_key || "").trim()) {
      const wallet = resolveDepositWalletAddress({
        privateKey: exe.private_key,
        chainId: exe.chain_id,
        configuredFunder: depositWalletAddress || exe.funder || "",
      });
      console.log(
        `  builder relayer creds: ${pool.length} key(s) loaded (wallet=${wallet.slice(0, 10)}…)`,
      );
    } else {
      console.log(`  builder relayer creds loaded: ${pool.length} key(s), first=${pool[0]![0].slice(0, 8)}...`);
    }
  }

  const targets = lm.markets;
  if (!targets.length) {
    console.log("ERROR: No markets configured in liquidity_maker.markets");
    return;
  }
  console.log(`Markets: ${targets.map((t) => [t.symbol, t.epoch])}`);

  const exportPath = lm.export_dir
    ? resolve(lm.export_dir, "liquidity_maker_activity.json")
    : null;

  const maxCycles = lm.cycles;
  let cycleCount = 0;
  let redeemScheduler: RedeemScheduler | null = null;
  if (lm.redeem_enabled !== false) {
    redeemScheduler = new RedeemScheduler(settings);
    redeemScheduler.start();
    const gap = lm.redeem_per_symbol_gap_seconds ?? 10;
    console.log(
      `  redeem queue: serial relayer, delay=${lm.redeem_delay_seconds}s ` +
        `+ per-symbol gap=${gap}s (btc, eth)`,
    );
  }

  try {
    while (maxCycles === 0 || cycleCount < maxCycles) {
      await waitForTradingWindow(settings.schedule);

      const minInterval = Math.min(...targets.map((t) => INTERVAL_SECONDS[t.epoch] ?? 300));
      const now = utcNow();
      const epochTs = Math.floor(now.getTime() / 1000 / minInterval) * minInterval;
      const epochEnd = new Date((epochTs + minInterval) * 1000);

      console.log(`\n${"=".repeat(50)}`);
      console.log(`CYCLE ${cycleCount + 1}  epoch_end=${epochEnd.toISOString()}`);
      console.log(`${"=".repeat(50)}`);

      const summaries = await runAllMarkets(targets, settings, exportPath, {
        redeemScheduler,
        clobClient,
        paperSession,
        runCycle: cycleCount + 1,
      });

      for (const s of summaries) {
        const symbol = String(s.symbol ?? "?");
        const epoch = String(s.epoch ?? "?");
        const err = s.error;
        if (err) {
          console.log(`  [${symbol}/${epoch}] ERROR: ${err}`);
        } else {
          const redeemTx = String(s.redeem_tx ?? "");
          if (redeemTx) {
            console.log(`  [${symbol}/${epoch}] OK  redeem=${redeemTx.slice(0, 16)}...`);
          } else {
            console.log(`  [${symbol}/${epoch}] OK  monitor_complete`);
          }
        }
      }

      cycleCount += 1;
      if (maxCycles > 0 && cycleCount >= maxCycles) {
        break;
      }

      while (utcNow().getTime() < epochEnd.getTime() + 2000) {
        await sleep(1000);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      console.log("\nInterrupted by user.");
    } else {
      throw e;
    }
  } finally {
    if (redeemScheduler) {
      const pending = redeemScheduler.pending;
      if (pending > 0) {
        console.log(`Waiting for ${pending} queued redeem job(s)...`);
      }
      await redeemScheduler.drain();
      await redeemScheduler.shutdown();
    }
    if (clobClient) {
      await clobClient.close();
    }
    console.log(`Shutdown. Cycles completed: ${cycleCount}`);
  }
}

function runWithLogging(settings: Settings): void {
  const lm = settings.liquidity_maker;
  console.log("Polymarket monitor → redeem");
  console.log(`  dry_run=${settings.bot.dry_run}`);
  console.log(`  paper_trading=${settings.bot.paper_trading}`);
  console.log(`  ${describeSchedule(settings.schedule)}`);
  console.log(
    `  monitor_ws_eval=${lm.monitor_poll_interval_s}s ` +
      `user_ws=${lm.monitor_user_ws_enabled !== false} ` +
      `balance_poll=${lm.monitor_balance_poll_interval_s ?? 0.3}s ` +
      `log=${lm.monitor_log_interval_s}s ` +
      `verbose_last=${lm.monitor_verbose_seconds_before_end}s ` +
      `strike_spot_log=${lm.log_strike_spot_interval_s}s ` +
      `redeem_enabled=${lm.redeem_enabled !== false} ` +
      `post_redeem_monitor=${lm.post_redeem_monitor_seconds}s`,
  );
  if (settings.bot.log_file.trim()) {
    console.log(
      `  log_file=${JSON.stringify(settings.bot.log_file)} append=${settings.bot.log_append} ` +
        `timestamp_name=${settings.bot.log_timestamp_name}`,
    );
  }
  const tpj = (lm.trading_process_jsonl || "").trim();
  if (tpj) {
    console.log(
      `  trading_process_jsonl=${JSON.stringify(tpj)} mode=${lm.trading_process_log_mode} ` +
        `interval_s=${lm.trading_process_log_interval_s} stdout=${lm.trading_process_log_stdout} ` +
        "(strategy logging only)",
    );
  }
  void runLoop(settings);
}

const program = new Command();

program
  .name("polybot5m")
  .description("Polymarket monitor order book → redeem")
  .option("-c, --config <path>", "Config file path", "config/default.yaml");

program
  .command("run")
  .description("Run: monitor order book → redeem, repeat")
  .option("--dry-run", "Simulate without redeeming on chain")
  .option("--paper", "Paper mode: skip on-chain redeem (monitor + export only)")
  .option("--cycles <n>", "Max cycles (0 = run forever)", (v) => parseInt(v, 10))
  .option("--log-file <path>", "Tee stdout/stderr to this path (empty disables)")
  .option("--log-append", "Append to log file instead of truncating")
  .option("--log-timestamp-name", "Use polybot5m_YYYYMMDD_HHMMSS.log under log path")
  .action((opts, cmd) => {
    const configPath = cmd.parent?.opts().config ?? "config/default.yaml";
    const settings = loadConfig(configPath);

    if (opts.dryRun) {
      settings.bot.dry_run = true;
    }
    if (opts.paper) {
      settings.bot.paper_trading = true;
    }
    if (settings.bot.paper_trading) {
      settings.bot.dry_run = false;
    }
    if (opts.cycles != null && !Number.isNaN(opts.cycles)) {
      settings.liquidity_maker.cycles = opts.cycles;
    }
    if (opts.logFile != null) {
      settings.bot.log_file = opts.logFile;
    }
    if (opts.logAppend) {
      settings.bot.log_append = true;
    }
    if (opts.logTimestampName) {
      settings.bot.log_timestamp_name = true;
    }

    const cleanupLog = installRunLogging(settings.bot.log_file, {
      logAppend: settings.bot.log_append,
      logTimestampName: settings.bot.log_timestamp_name,
    });
    try {
      runWithLogging(settings);
    } finally {
      cleanupLog();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
