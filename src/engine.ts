/** Monitor orderbook -> redeem. */

import type { MarketTarget, Settings, StrikeSpotContext } from "./config.js";
import { INTERVAL_SECONDS, PUSD_ADDRESS } from "./constants.js";
import { pollBooksIntoStore } from "./data/clobRest.js";
import { runChainlinkSpotLoop, stopEventFromAbort } from "./data/chainlinkFeed.js";
import { GammaClient } from "./data/gamma.js";
import { resolveOutcomeTokenIds } from "./data/models.js";
import { pairDepthMetricsForMonitor } from "./data/orderbookInfluence.js";
import { computeEpochSlugs } from "./data/slugBuilder.js";
import { fetchEpochStrike } from "./data/strikePrice.js";
import { resolveCollateralAdapter } from "./execution/collateralAdapter.js";
import { resolveDepositWalletAddress } from "./execution/depositWallet.js";
import { EntryStrategyCoordinator } from "./execution/exitStrategy.js";
import {
  MonitorWavePart,
  MonitorWavePrintGate,
  bestAskFromBook,
  bestBidFromBook,
  chainlinkFeedIdForSymbol,
  fmtStrikeSpotPrice,
  monitorOrderbookUntilEpochEnd,
  resolveClobWsAuth,
  spotForStrikeCompare,
  withClobMonitorSession,
} from "./execution/executor.js";
import type { ClobClient } from "./execution/clobClient.js";
import { PaperV2Account, type PaperSessionLedger } from "./execution/paperExchange.js";
import { RedeemJob, RedeemScheduler } from "./execution/redeemScheduler.js";
import {
  SpotMinusStrikeEpochAverage,
  TradingCycleJournal,
  TradingCycleKey,
  appendTradingJsonl,
  formatAverageSpotMinusForLog,
  resolveTradingProcessPath,
  spotMinusStrikeUsd,
  utcIsoZ,
} from "./tradingProcessLog.js";

export const Phase = {
  IDLE: "IDLE",
  MONITOR: "MONITOR",
  REDEEM: "REDEEM",
} as const;

function utcNow(): Date {
  return new Date();
}

function tag(symbol: string, epoch: string): string {
  return `[${symbol}/${epoch}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBtcWaveMonitor(
  settings: Settings,
  epoch: string,
  epochEnd: Date,
  monitorWaveGate: MonitorWavePrintGate,
  options: {
    pollIntervalS: number;
    clobWsUrl?: string | null;
    clobClient?: ClobClient | null;
    entryCoordinator?: EntryStrategyCoordinator | null;
  },
): Promise<void> {
  const t = tag("btc", epoch);
  const lm = settings.liquidity_maker;
  const exe = settings.execution;
  const userAuth = resolveClobWsAuth({
    apiKey: exe.api_key,
    apiSecret: exe.api_secret,
    apiPassphrase: exe.api_passphrase,
    clobClient: options.clobClient,
  });
  const monitorUserWs = lm.monitor_user_ws_enabled !== false;
  const restTimeoutS = Math.max(0.5, lm.monitor_rest_book_timeout_s ?? 3.0);
  const btcSmsEpochAvg = new SpotMinusStrikeEpochAverage();
  const oracleAbort = new AbortController();
  let oracleTask: Promise<void> | null = null;

  try {
    const slugs = computeEpochSlugs("btc", epoch);
    let event;
    try {
      const gamma = new GammaClient(settings.api.gamma_url);
      event = await gamma.fetchEventBySlug(slugs.currentSlug);
    } catch (e) {
      console.log(`  ${t} BTC wave monitor skipped: ${e}`);
      return;
    }

    const assetIds = event.allAssetIds();
    if (assetIds.length !== 2) {
      console.log(`  ${t} BTC wave monitor skipped: invalid asset IDs`);
      return;
    }
    const yesTokenId = assetIds[0]!;
    const noTokenId = assetIds[1]!;
    let btcConditionId = "";
    if (event.markets[0]) {
      btcConditionId = (event.markets[0].conditionId || "").trim();
    }

    const pf = settings.price_feed;
    const strikeSpotFeed: StrikeSpotContext = {
      symbol: "btc",
      epoch_start_unix: Math.floor(slugs.currentStart.getTime() / 1000),
      interval_secs: INTERVAL_SECONDS[epoch] ?? 300,
      strike_provider: pf.provider,
      chainlink_user_id: pf.chainlink.streams_user_id,
      chainlink_secret: pf.chainlink.streams_secret,
      chainlink_feed_ids: { ...pf.chainlink.feed_ids },
      market_slug: slugs.currentSlug,
      spot_provider: pf.spot_provider,
      chainlink_spot_poll_interval_s: pf.chainlink_spot_poll_interval_s ?? 1.0,
    };

    const priceStore: Record<string, number> = {};
    const productId = "BTC-USD";
    const spotLogKey = "chainlink_spot";
    const fid = chainlinkFeedIdForSymbol(strikeSpotFeed.chainlink_feed_ids, strikeSpotFeed.symbol);
    const useChainlinkSpot = Boolean(
      strikeSpotFeed.chainlink_user_id && strikeSpotFeed.chainlink_secret && fid,
    );

    if (useChainlinkSpot && fid) {
      oracleTask = runChainlinkSpotLoop(
        strikeSpotFeed.symbol,
        fid,
        strikeSpotFeed.chainlink_user_id,
        strikeSpotFeed.chainlink_secret,
        productId,
        priceStore,
        stopEventFromAbort(oracleAbort.signal),
        strikeSpotFeed.chainlink_spot_poll_interval_s,
      );
    } else {
      console.log(`  ${t} spot: chainlink missing user/secret or feed_id for btc`);
    }

    for (let i = 0; i < 50; i += 1) {
      if (priceStore[productId]) {
        break;
      }
      await sleep(100);
    }

    const strike = await fetchEpochStrike(
      strikeSpotFeed.symbol.toLowerCase(),
      strikeSpotFeed.epoch_start_unix,
      priceStore,
      strikeSpotFeed.strike_provider,
      strikeSpotFeed.interval_secs,
      strikeSpotFeed.chainlink_user_id,
      strikeSpotFeed.chainlink_secret,
      strikeSpotFeed.chainlink_feed_ids,
      strikeSpotFeed.market_slug || "",
    );

    await withClobMonitorSession(
      {
        clobWsUrl: options.clobWsUrl,
        yesTokenId,
        noTokenId,
        conditionId: btcConditionId,
        userWsAuth: userAuth,
        userWsEnabled: monitorUserWs && !settings.bot.paper_trading,
        tag: t,
        remainingSFn: () => Math.max(0, (epochEnd.getTime() - utcNow().getTime()) / 1000),
      },
      async (monitorBundle) => {
        const bookStore = monitorBundle.bookStore;
        while (utcNow() < epochEnd) {
          const remainingS = Math.max(0, (epochEnd.getTime() - utcNow().getTime()) / 1000);
          const ok = await pollBooksIntoStore(bookStore, yesTokenId, noTokenId, {
            baseUrl: settings.api.clob_url,
            timeoutS: restTimeoutS,
          });
          if (!ok) {
            await sleep(options.pollIntervalS * 1000);
            continue;
          }

          const bookYes = bookStore.bookAsExecutorView(yesTokenId);
          const bookNo = bookStore.bookAsExecutorView(noTokenId);
          const depthMetrics = pairDepthMetricsForMonitor(bookYes, bookNo, { topN: 5 });
          const spotThisRaw = priceStore[productId];
          const tickStrike = strike > 0 ? strike : null;
          const tickSpot = spotForStrikeCompare(spotThisRaw);
          const ts = strike > 0 ? fmtStrikeSpotPrice(strike) : "—";
          const ss = spotThisRaw && spotThisRaw > 0 ? fmtStrikeSpotPrice(spotThisRaw) : "—";
          const smsValueBtc = spotMinusStrikeUsd(tickStrike, tickSpot);
          const sms = smsValueBtc == null ? "—" : smsValueBtc.toFixed(6);
          const avgSuffix = formatAverageSpotMinusForLog(
            "btc",
            btcSmsEpochAvg.record(smsValueBtc),
          );

          if (options.entryCoordinator) {
            options.entryCoordinator.updateBtcStrategyContext({
              spotMinusStrikeBtc: smsValueBtc,
              avergeSpotMinusBtc: btcSmsEpochAvg.average(),
              bestBidYes: bestBidFromBook(bookYes),
              bestBidNo: bestBidFromBook(bookNo),
              bestAskYes: bestAskFromBook(bookYes),
              bestAskNo: bestAskFromBook(bookNo),
            });
          }

          const strikeLine =
            `${t} [STRIKE_SPOT] target=${ts} ${spotLogKey}=${ss} ` +
            `spot_minus_strike_btc=${sms}${avgSuffix}`;

          let maxSms: number | null = null;
          let minSms: number | null = null;
          if (options.entryCoordinator) {
            [maxSms, minSms] = options.entryCoordinator.btcWaveExtrema();
          }

          await monitorWaveGate.submitWave(
            "btc",
            new MonitorWavePart({
              symbol: "btc",
              tMinusS: remainingS,
              maxSpotMinusStrikeBtc: maxSms,
              minSpotMinusStrikeBtc: minSms,
              strikeSpotLine: strikeLine,
              influenceValue: depthMetrics.influenceRate,
              marketLine: "",
            }),
          );
          await sleep(options.pollIntervalS * 1000);
        }
      },
    );
  } finally {
    oracleAbort.abort();
    if (oracleTask) {
      await Promise.race([oracleTask.catch(() => undefined), sleep(5000)]);
    }
    await monitorWaveGate.deactivate("btc");
  }
}

export async function runMarketCycle(
  target: MarketTarget,
  settings: Settings,
  exportPath: string | null = null,
  marketIndex = 0,
  options: {
    monitorWaveGate?: MonitorWavePrintGate | null;
    redeemScheduler?: RedeemScheduler | null;
    clobClient?: ClobClient | null;
    paperSession?: PaperSessionLedger | null;
    entryCoordinator?: EntryStrategyCoordinator | null;
    runCycle?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const lm = settings.liquidity_maker;
  const exe = settings.execution;
  const t = tag(target.symbol, target.epoch);
  const symKey = String(target.symbol).toLowerCase().trim();
  const paperTrading = Boolean(settings.bot.paper_trading);
  const slugs = computeEpochSlugs(target.symbol, target.epoch);
  const epochStart = slugs.currentStart;
  const epochEnd = new Date(epochStart.getTime() + (INTERVAL_SECONDS[target.epoch] ?? 300) * 1000);

  const summary: Record<string, unknown> = {
    symbol: target.symbol,
    epoch: target.epoch,
    slug: slugs.currentSlug,
    epoch_start: epochStart.toISOString(),
    epoch_end: epochEnd.toISOString(),
    phase: Phase.IDLE,
    redeem_tx: null,
    error: null,
  };

  const tpPath = resolveTradingProcessPath(settings);
  const epochStartUnix = Math.floor(epochStart.getTime() / 1000);
  const epochEndUnix = Math.floor(epochEnd.getTime() / 1000);
  let tradingJournal: TradingCycleJournal | null = null;
  let tpMode = (lm.trading_process_log_mode || "trades").trim().toLowerCase();
  if (tpMode !== "full" && tpMode !== "trades") {
    tpMode = "trades";
  }
  const tpFullLog = tpMode === "full";
  const pollInterval = lm.monitor_poll_interval_s ?? 0.5;
  const balancePollInterval = lm.monitor_balance_poll_interval_s ?? 0.3;
  const logInterval = lm.monitor_log_interval_s ?? 1.0;
  const verboseBefore = lm.monitor_verbose_seconds_before_end ?? 5.0;
  const logStrikeSpotIv = lm.log_strike_spot_interval_s ?? 0;
  const diffRateLookbackLm = lm.spot_minus_strike_difference_rate_lookback_s ?? 0;
  console.log(`  ${t} slug=${slugs.currentSlug}`);

  let event;
  try {
    const gamma = new GammaClient(settings.api.gamma_url);
    event = await gamma.fetchEventBySlug(slugs.currentSlug);
  } catch (e) {
    summary.error = `No event for slug: ${e}`;
    if (options.monitorWaveGate) {
      await options.monitorWaveGate.deactivate(symKey);
    }
    return summary;
  }

  const market = event.markets[0];
  if (!market || market.assetIds.length !== 2) {
    summary.error = `Expected 2 asset IDs (YES/NO), got ${market?.assetIds.length ?? 0}`;
    if (options.monitorWaveGate) {
      await options.monitorWaveGate.deactivate(symKey);
    }
    return summary;
  }

  const conditionId = market.conditionId;
  let yesToken: string;
  let noToken: string;
  try {
    [yesToken, noToken] = resolveOutcomeTokenIds(market);
  } catch (e) {
    summary.error = String(e);
    if (options.monitorWaveGate) {
      await options.monitorWaveGate.deactivate(symKey);
    }
    return summary;
  }
  console.log(`  ${t} condition_id=${conditionId.slice(0, 24)}...`);

  let walletAddr = "";
  if ((exe.private_key || "").trim()) {
    walletAddr = resolveDepositWalletAddress({
      privateKey: exe.private_key,
      chainId: exe.chain_id,
      configuredFunder: exe.funder || "",
    });
  }

  let strikeSpotFeed: StrikeSpotContext | null = null;
  const wantStrikeSpot = logStrikeSpotIv > 0 || diffRateLookbackLm > 0;
  if (wantStrikeSpot) {
    const pf = settings.price_feed;
    strikeSpotFeed = {
      symbol: target.symbol.toLowerCase(),
      epoch_start_unix: Math.floor(slugs.currentStart.getTime() / 1000),
      interval_secs: INTERVAL_SECONDS[target.epoch] ?? 300,
      strike_provider: pf.provider,
      chainlink_user_id: pf.chainlink.streams_user_id,
      chainlink_secret: pf.chainlink.streams_secret,
      chainlink_feed_ids: { ...pf.chainlink.feed_ids },
      market_slug: slugs.currentSlug,
      spot_provider: pf.spot_provider,
      chainlink_spot_poll_interval_s: pf.chainlink_spot_poll_interval_s ?? 1.0,
    };
  }

  if (tpPath) {
    tradingJournal = new TradingCycleJournal(
      tpPath,
      new TradingCycleKey(
        options.runCycle ?? 0,
        symKey,
        String(target.epoch),
        slugs.currentSlug,
        epochStartUnix,
        epochEndUnix,
        conditionId,
        paperTrading,
        yesToken,
        noToken,
      ),
      t,
    );
    tradingJournal.logCycleStart({ dry_run: settings.bot.dry_run });
  }

  const adapterAddress = await resolveCollateralAdapter(yesToken, options.clobClient, {
    ctfAdapterOverride: settings.execution.ctf_collateral_adapter || "",
    negRiskAdapterOverride: settings.execution.neg_risk_ctf_collateral_adapter || "",
  });
  const collateral = (exe.collateral_token || "").trim() || PUSD_ADDRESS;

  summary.phase = Phase.MONITOR;
  let paperAccount: PaperV2Account | null = null;
  if (paperTrading && options.paperSession) {
    paperAccount = new PaperV2Account(yesToken, noToken, { session: options.paperSession });
  }

  let strikeLogIv = logStrikeSpotIv;
  if (wantStrikeSpot && strikeLogIv <= 0) {
    strikeLogIv = pollInterval;
  }

  const monitorSummary = await monitorOrderbookUntilEpochEnd(
    settings.api.clob_url,
    yesToken,
    noToken,
    epochEnd,
    {
      tag: t,
      pollIntervalS: pollInterval,
      marketLogIntervalS: logInterval,
      monitorVerboseSecondsBeforeEnd: verboseBefore,
      strikeSpotFeed,
      logStrikeSpotIntervalS: strikeLogIv,
      runStrikeSpotOracle: wantStrikeSpot,
      tradingProcessPath: tpPath,
      tradingJournal,
      tradingProcessLogMode: tpMode,
      tradingProcessLogIntervalS: lm.trading_process_log_interval_s ?? 0,
      tradingProcessLogStdout: Boolean(lm.trading_process_log_stdout) && !options.monitorWaveGate,
      monitorWaveGate: options.monitorWaveGate,
      monitorGateSymbol: symKey,
      spotMinusStrikeDifferenceRateLookbackS: diffRateLookbackLm,
      clobClient: options.clobClient,
      paperAccount,
      balancePollIntervalS: balancePollInterval,
      conditionId,
      splitInventoryYes: 0,
      splitInventoryNo: 0,
      balanceRpcUrl: exe.rpc_url,
      balanceWalletAddress: walletAddr,
      clobWsUrl: settings.api.ws_url,
      clobApiKey: exe.api_key,
      clobApiSecret: exe.api_secret,
      clobApiPassphrase: exe.api_passphrase,
      monitorUserWsEnabled: lm.monitor_user_ws_enabled !== false && !paperTrading,
      monitorContext: options.entryCoordinator,
      entrySymbol: symKey,
      restBookTimeoutS: lm.monitor_rest_book_timeout_s ?? 3.0,
      balanceRefreshTimeoutS: lm.monitor_balance_refresh_timeout_s ?? 3.0,
      balanceForceRefreshMinS: lm.monitor_balance_force_refresh_min_s ?? 1.0,
    },
  );
  summary.monitor = monitorSummary;

  if (options.monitorWaveGate) {
    await options.monitorWaveGate.deactivate(symKey);
  }

  const redeemEnabled = lm.redeem_enabled !== false;
  const redeemAsync = lm.redeem_async_enabled !== false;

  if (redeemEnabled && options.redeemScheduler) {
    const job = new RedeemJob({
      conditionId,
      adapterAddress,
      collateral,
      symbol: symKey,
      epoch: String(target.epoch),
      tag: t,
      marketIndex,
      epochEnd,
      slug: slugs.currentSlug,
      summary,
      exportPath,
      yesToken,
      noToken,
      pollInterval,
      clobUrl: settings.api.clob_url,
      paperTrading,
      dryRun: settings.bot.dry_run,
    });
    await options.redeemScheduler.schedule(job, { wait: !redeemAsync });
  } else if (!redeemEnabled) {
    summary.phase = Phase.IDLE;
    console.log(`  ${t} REDEEM skipped (redeem_enabled=false)`);
  }

  if (tradingJournal) {
    tradingJournal.logCycleEnd({
      error: summary.error,
      redeem_tx: summary.redeem_tx,
      phase: summary.phase,
    });
  } else if (tpPath && tpFullLog) {
    appendTradingJsonl(tpPath, {
      event: "MARKET_CYCLE_END",
      ts_utc: utcIsoZ(),
      tag: t,
      error: summary.error,
      redeem_tx: summary.redeem_tx,
    });
  }
  return summary;
}

export async function runAllMarkets(
  targets: MarketTarget[],
  settings: Settings,
  exportPath: string | null = null,
  options: {
    redeemScheduler?: RedeemScheduler | null;
    clobClient?: ClobClient | null;
    paperSession?: PaperSessionLedger | null;
    runCycle?: number;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const lm = settings.liquidity_maker;
  const stagger = lm.stagger_delay_seconds ?? 0;
  const redeemEnabled = lm.redeem_enabled !== false;

  const symbols = new Set(
    targets.map((t) => String(t.symbol).toLowerCase().trim()).filter(Boolean),
  );
  const symbolsForWave = new Set(symbols);
  symbolsForWave.add("btc");

  const monitorWaveGate = targets.length
    ? new MonitorWavePrintGate(symbolsForWave, {
        waveCollectTimeoutS: lm.monitor_wave_collect_timeout_s ?? 3.0,
      })
    : null;
  monitorWaveGate?.start();

  const pollIv = lm.monitor_poll_interval_s ?? 0.5;
  const entryCoordinator = new EntryStrategyCoordinator(settings);
  entryCoordinator.resetBtcEpochStats();

  let btcWaveTask: Promise<void> | null = null;
  if (monitorWaveGate && !symbols.has("btc")) {
    const epochForBtc = targets[0]?.epoch ?? "5m";
    const btcSlugs = computeEpochSlugs("btc", epochForBtc);
    const epochEndBtc = new Date(
      btcSlugs.currentStart.getTime() + (INTERVAL_SECONDS[epochForBtc] ?? 300) * 1000,
    );
    btcWaveTask = runBtcWaveMonitor(settings, epochForBtc, epochEndBtc, monitorWaveGate, {
      pollIntervalS: pollIv,
      clobWsUrl: settings.api.ws_url,
      clobClient: options.clobClient,
      entryCoordinator,
    });
  }

  const runWithDelay = async (i: number, target: MarketTarget) => {
    if (i > 0 && stagger > 0) {
      const delay = i * stagger;
      console.log(`  [${target.symbol}/${target.epoch}] waiting ${delay}s before monitor...`);
      await sleep(delay * 1000);
    }
    return runMarketCycle(target, settings, exportPath, i, {
      monitorWaveGate,
      redeemScheduler: redeemEnabled ? options.redeemScheduler : null,
      clobClient: options.clobClient,
      paperSession: options.paperSession,
      entryCoordinator,
      runCycle: options.runCycle,
    });
  };

  let results: Array<Record<string, unknown> | Error>;
  try {
    results = await Promise.all(
      targets.map((target, i) =>
        runWithDelay(i, target).catch((e) => e as Error),
      ),
    );
  } finally {
    if (btcWaveTask) {
      await Promise.race([btcWaveTask.catch(() => undefined), sleep(1000)]);
    }
    if (monitorWaveGate) {
      await monitorWaveGate.shutdown();
    }
  }

  return results.map((result, i) => {
    if (result instanceof Error) {
      return {
        symbol: targets[i]!.symbol,
        epoch: targets[i]!.epoch,
        error: String(result),
      };
    }
    return result;
  });
}

export { runBtcWaveMonitor };
