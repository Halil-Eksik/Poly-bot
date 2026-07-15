/** Monitor YES/NO CLOB books until epoch end (REST poll + fixed-interval evaluation). */

import type { StrikeSpotContext } from "../config.js";
import { WS_URL } from "../constants.js";
import { fetchOrderBook, pollBooksIntoStore } from "../data/clobRest.js";
import {
  ClobUserWebSocket,
  ClobWsCredentials,
  credentialsFromClobClient,
  normalizeConditionId,
} from "../data/clobUserWs.js";
import { runChainlinkSpotLoop, stopEventFromAbort } from "../data/chainlinkFeed.js";
import { pairDepthMetricsForMonitor, type PairDepthMetrics } from "../data/orderbookInfluence.js";
import type { ExecutorBookView, InMemoryOrderbookStore } from "../data/orderbook.js";
import { InMemoryOrderbookStore as BookStore } from "../data/orderbook.js";
import { fetchEpochStrike } from "../data/strikePrice.js";
import type { UserChannelStore } from "../data/userChannelStore.js";
import { UserChannelStore as UserStore } from "../data/userChannelStore.js";
import {
  SpotMinusStrikeEpochAverage,
  TradingCycleJournal,
  appendTradingJsonl,
  enrichStrategyRowTMinus,
  formatAverageSpotMinusForLog,
  formatSpotMinusStrikeForLog,
  formatTMinusSuffix,
  spotMinusStrikeUsd,
  utcIsoZ,
} from "../tradingProcessLog.js";
import type { ClobClient } from "./clobClient.js";
import type { EntryStrategyCoordinator } from "./exitStrategy.js";
import type { PaperV2Account } from "./paperExchange.js";

export const MONITOR_LOG_SEPARATOR = "-----------------------------------------------------------";
export const MONITOR_WAVE_SEP_OUTER = "-".repeat(62);
export const MONITOR_WAVE_SEP_INNER = "-".repeat(23);
export const MONITOR_WAVE_SEP_CLOSE = "-".repeat(66);

const CANONICAL_MONITOR_LOG_SYMBOL_ORDER = ["btc", "eth"] as const;
const STRIKE_SPOT_LOG_DECIMALS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcNow(): Date {
  return new Date();
}

export function fmtStrikeSpotPrice(v: number | null | undefined): string {
  if (v == null) {
    return "—";
  }
  const x = Number(v);
  if (!Number.isFinite(x) || !(x > 0)) {
    return "—";
  }
  return x.toFixed(STRIKE_SPOT_LOG_DECIMALS);
}

export function monitorBundlePrintOrder(symbolsPresent: Set<string>): string[] {
  const s = new Set(
    [...symbolsPresent].map((x) => String(x).toLowerCase().trim()).filter(Boolean),
  );
  const ordered = CANONICAL_MONITOR_LOG_SYMBOL_ORDER.filter((sym) => s.has(sym));
  const rest = [...s].filter((sym) => !ordered.includes(sym as (typeof ordered)[number])).sort();
  return [...ordered, ...rest];
}

export class MonitorWavePart {
  symbol = "";
  tMinusS = 0;
  maxSpotMinusStrikeBtc: number | null = null;
  minSpotMinusStrikeBtc: number | null = null;
  strikeSpotLine: string | null = null;
  influenceValue: number | null = null;
  statusLine: string | null = null;
  marketLine = "";

  constructor(fields?: Partial<MonitorWavePart>) {
    Object.assign(this, fields);
  }
}

class BoundedAsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: T) => void> = [];

  constructor(private readonly maxSize: number) {}

  get empty(): boolean {
    return this.items.length === 0;
  }

  putNow(item: T): boolean {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
      return true;
    }
    if (this.items.length >= this.maxSize) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  async put(item: T): Promise<void> {
    if (this.putNow(item)) {
      return;
    }
    const q = this.items;
    if (q.length >= this.maxSize) {
      q.shift();
    }
    q.push(item);
  }

  async get(timeoutS: number): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error("timeout"));
      }, timeoutS * 1000);
      this.waiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  tryGetNow(): T | undefined {
    return this.items.shift();
  }
}

export class MonitorWavePrintGate {
  private readonly waveCollectTimeoutS: number;
  private readonly order: string[];
  private readonly queues: Map<string, BoundedAsyncQueue<MonitorWavePart | null>>;
  private active: Set<string>;
  private closed = false;
  private writerTask: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(symbolsPresent: Set<string>, options?: { waveCollectTimeoutS?: number }) {
    this.waveCollectTimeoutS = Math.max(0.1, options?.waveCollectTimeoutS ?? 3.0);
    this.order = monitorBundlePrintOrder(symbolsPresent);
    this.queues = new Map(this.order.map((s) => [s, new BoundedAsyncQueue<MonitorWavePart | null>(2)]));
    this.active = new Set(this.order);
  }

  start(): void {
    if (!this.writerTask) {
      this.writerTask = this.writerLoop();
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const s of this.order) {
      const q = this.queues.get(s)!;
      if (!q.putNow(null)) {
        q.tryGetNow();
        q.putNow(null);
      }
    }
    if (this.writerTask) {
      await Promise.race([this.writerTask, sleep(5000)]);
    }
  }

  async deactivate(sym: string): Promise<void> {
    const key = String(sym).toLowerCase().trim();
    await this.withLock(() => {
      this.active.delete(key);
    });
    const q = this.queues.get(key);
    if (!q) {
      return;
    }
    const dummy = new MonitorWavePart({ tMinusS: 0, marketLine: "" });
    if (!q.putNow(dummy)) {
      q.tryGetNow();
      q.putNow(dummy);
    }
  }

  async submitWave(sym: string, part: MonitorWavePart): Promise<void> {
    const key = String(sym).toLowerCase().trim();
    const q = this.queues.get(key);
    if (!q) {
      return;
    }
    await q.put(part);
  }

  private async withLock(fn: () => void): Promise<void> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      fn();
    } finally {
      release();
    }
  }

  private printMergedWave(parts: Map<string, MonitorWavePart>): void {
    console.log(MONITOR_WAVE_SEP_OUTER);
    let t0 = 0;
    for (const s of this.order) {
      const p = parts.get(s);
      if (p) {
        t0 = p.tMinusS;
        break;
      }
    }
    console.log(`⏰t_minus=${t0.toFixed(3)}s`);
    for (const s of this.order) {
      const p = parts.get(s);
      if (p?.strikeSpotLine) {
        console.log(p.strikeSpotLine);
      }
    }
    console.log(MONITOR_WAVE_SEP_INNER);
    for (const s of this.order) {
      const p = parts.get(s);
      if (p?.marketLine) {
        console.log(p.marketLine);
      }
    }
    console.log(MONITOR_WAVE_SEP_CLOSE);
  }

  private async writerLoop(): Promise<void> {
    while (true) {
      if (this.closed && this.order.every((s) => this.queues.get(s)!.empty)) {
        break;
      }
      const waveSyms = this.order.filter((s) => this.active.has(s));
      if (waveSyms.length === 0) {
        await sleep(20);
        continue;
      }
      const parts = new Map<string, MonitorWavePart>();
      for (const s of waveSyms) {
        const q = this.queues.get(s)!;
        try {
          const item = await q.get(this.waveCollectTimeoutS);
          if (item === null) {
            if (this.closed) {
              return;
            }
            continue;
          }
          parts.set(s, item);
        } catch {
          break;
        }
      }
      if (parts.size < waveSyms.length) {
        if (parts.size === 0) {
          continue;
        }
        const first = parts.values().next().value!;
        for (const s of waveSyms) {
          if (!parts.has(s)) {
            parts.set(
              s,
              new MonitorWavePart({
                symbol: s,
                tMinusS: first.tMinusS,
                marketLine: `  [${s}/5m] [MARKET_TICK] — (no tick within ${this.waveCollectTimeoutS.toFixed(1)}s)`,
              }),
            );
          }
        }
      }
      if (parts.size > 0) {
        this.printMergedWave(parts);
      }
    }
  }
}

function depthMetricsForJsonl(m: PairDepthMetrics): Record<string, number> {
  return {
    yes_bid_5_sum: m.yesBid5Sum,
    yes_ask_5_sum: m.yesAsk5Sum,
    yes_bid_5_levels: m.yesBid5Levels,
    yes_ask_5_levels: m.yesAsk5Levels,
    yes_influence_rate: m.yesInfluenceRate,
    no_bid_5_sum: m.noBid5Sum,
    no_ask_5_sum: m.noAsk5Sum,
    no_bid_5_levels: m.noBid5Levels,
    no_ask_5_levels: m.noAsk5Levels,
    no_influence_rate: m.noInfluenceRate,
    influence_rate: m.influenceRate,
  };
}

export function bestBidFromBook(book: ExecutorBookView | null | undefined): number {
  if (!book?.bids?.length) {
    return 0;
  }
  const prices: number[] = [];
  for (const b of book.bids) {
    const p = Number(b.price);
    if (p > 0 && p <= 1) {
      prices.push(p);
    }
  }
  return prices.length ? Math.max(...prices) : 0;
}

export function bestAskFromBook(book: ExecutorBookView | null | undefined): number {
  if (!book?.asks?.length) {
    return 0;
  }
  const prices: number[] = [];
  for (const a of book.asks) {
    const p = Number(a.price);
    if (p > 0 && p <= 1) {
      prices.push(p);
    }
  }
  return prices.length ? Math.min(...prices) : 0;
}

function formatYesNoBookPrices(
  bestAskYes: number,
  bestBidYes: number,
  bestAskNo: number,
  bestBidNo: number,
): string {
  return (
    `🟢YES best_ask=${bestAskYes.toFixed(4)} best_bid=${bestBidYes.toFixed(4)} ` +
    `🔴NO best_ask=${bestAskNo.toFixed(4)} best_bid=${bestBidNo.toFixed(4)}`
  );
}

function remInventorySuffix(remYes: number, remNo: number, showInventory: boolean): string {
  if (!showInventory) {
    return "";
  }
  return ` rem_YES=${remYes.toFixed(4)} rem_NO=${remNo.toFixed(4)}`;
}

function remInventoryMarketTickSuffix(
  symbol: string,
  remYes: number,
  remNo: number,
  showInventory: boolean,
): string {
  const sym = symbol.toLowerCase().trim();
  if (!sym || !showInventory) {
    return "";
  }
  return ` 🟢rem_YES_${sym}=${remYes.toFixed(4)} 🔴rem_NO_${sym}=${remNo.toFixed(4)}`;
}

export function chainlinkFeedIdForSymbol(
  feedIds: Record<string, string>,
  symbol: string,
): string | null {
  const v = feedIds[symbol.toLowerCase().trim()];
  if (v == null) {
    return null;
  }
  const s = String(v).trim();
  return s || null;
}

export function spotForStrikeCompare(raw: number | null | undefined): number | null {
  if (raw == null || raw <= 0) {
    return null;
  }
  return Number(raw);
}

export interface MonitorBookBundle {
  bookStore: InMemoryOrderbookStore;
  userStore: UserChannelStore | null;
}

export function resolveClobWsAuth(options?: {
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  clobClient?: ClobClient | null;
}): ClobWsCredentials | null {
  const fromClient = credentialsFromClobClient(options?.clobClient);
  if (fromClient) {
    return fromClient;
  }
  const auth = new ClobWsCredentials(
    (options?.apiKey || "").trim(),
    (options?.apiSecret || "").trim(),
    (options?.apiPassphrase || "").trim(),
  );
  return auth.valid() ? auth : null;
}

function logUserTradeEvent(options: {
  tag: string;
  tradingProcessPath: string | null;
  tradingJournal: TradingCycleJournal | null;
  userStore: UserChannelStore;
  data: Record<string, unknown>;
  remainingS?: number | null;
}): void {
  let row = options.userStore.tradeRowForLog(options.data);
  row = { ...row, tag: options.tag };
  row = enrichStrategyRowTMinus(row, { remainingS: options.remainingS });
  if (options.tradingJournal) {
    options.tradingJournal.logUserTrade(row);
  } else if (options.tradingProcessPath) {
    row = { ...row, ts_utc: utcIsoZ() };
    appendTradingJsonl(options.tradingProcessPath, row);
  }
  console.log(
    `  ${options.tag} [USER_TRADE] ${row.outcome} ${row.side} ` +
      `px=${row.price} sz=${row.size} status=${row.status} trader_side=${row.trader_side}` +
      `${formatTMinusSuffix(options.remainingS)}`,
  );
}

export async function withClobMonitorSession<T>(
  options: {
    clobWsUrl?: string | null;
    yesTokenId: string;
    noTokenId: string;
    conditionId?: string;
    userWsAuth?: ClobWsCredentials | null;
    userWsEnabled?: boolean;
    tradingProcessPath?: string | null;
    tradingJournal?: TradingCycleJournal | null;
    tag?: string;
    remainingSFn?: () => number;
  },
  fn: (bundle: MonitorBookBundle) => Promise<T>,
): Promise<T> {
  const ws = (options.clobWsUrl || "").trim() || WS_URL;
  const store = new BookStore();
  let userStore: UserChannelStore | null = null;
  let userClient: ClobUserWebSocket | null = null;
  const cid = normalizeConditionId(options.conditionId || "");
  const tag = options.tag || "";

  try {
    if (
      options.userWsEnabled !== false &&
      options.userWsAuth?.valid() &&
      cid
    ) {
      userStore = new UserStore(cid, options.yesTokenId, options.noTokenId);
      const onTrade = async (data: Record<string, unknown>) => {
        userStore!.applyTrade(data);
        const rem = options.remainingSFn?.() ?? null;
        logUserTradeEvent({
          tag,
          tradingProcessPath: options.tradingProcessPath ?? null,
          tradingJournal: options.tradingJournal ?? null,
          userStore: userStore!,
          data,
          remainingS: rem,
        });
      };
      userClient = new ClobUserWebSocket({ wsUrl: ws, auth: options.userWsAuth, onTrade });
      try {
        await userClient.connect([cid]);
        console.log(`  ${tag} MONITOR user WS ${ws}/ws/user condition=${cid.slice(0, 24)}...`);
      } catch (e) {
        console.log(`  ${tag} MONITOR user WS auth failed: ${e}`);
        userStore = null;
        userClient = null;
      }
    }
    return await fn({ bookStore: store, userStore });
  } finally {
    if (userClient) {
      await userClient.disconnect();
    }
  }
}

export async function postRedeemMonitorOrderbooks(
  clobBaseUrl: string,
  yesTokenId: string,
  noTokenId: string,
  durationS: number,
  tag: string,
  pollIntervalS: number,
): Promise<void> {
  if (durationS <= 0) {
    return;
  }
  const end = performance.now() / 1000 + durationS;
  console.log(`  ${tag} POST_REDEEM monitor ${durationS}s`);
  while (performance.now() / 1000 < end) {
    try {
      const [bookYes, bookNo] = await Promise.all([
        fetchOrderBook(yesTokenId, clobBaseUrl),
        fetchOrderBook(noTokenId, clobBaseUrl),
      ]);
      const ay = bestAskFromBook(bookYes);
      const an = bestAskFromBook(bookNo);
      console.log(MONITOR_LOG_SEPARATOR);
      console.log(
        `  ${tag} [POST_REDEEM] 🟢YES best_ask=${ay.toFixed(4)} 🔴NO best_ask=${an.toFixed(4)} sum=${(ay + an).toFixed(4)}`,
      );
    } catch (e) {
      console.log(`  ${tag} [POST_REDEEM] book error: ${e}`);
    }
    await sleep(pollIntervalS * 1000);
  }
}

export interface MonitorOrderbookOptions {
  tag?: string;
  pollIntervalS?: number;
  marketLogIntervalS?: number;
  monitorVerboseSecondsBeforeEnd?: number;
  strikeSpotFeed?: StrikeSpotContext | null;
  logStrikeSpotIntervalS?: number;
  runStrikeSpotOracle?: boolean;
  tradingProcessPath?: string | null;
  tradingJournal?: TradingCycleJournal | null;
  tradingProcessLogMode?: string;
  tradingProcessLogIntervalS?: number;
  tradingProcessLogStdout?: boolean;
  monitorWaveGate?: MonitorWavePrintGate | null;
  monitorGateSymbol?: string;
  spotMinusStrikeDifferenceRateLookbackS?: number;
  clobClient?: ClobClient | null;
  paperAccount?: PaperV2Account | null;
  balancePollIntervalS?: number | null;
  conditionId?: string;
  splitInventoryYes?: number;
  splitInventoryNo?: number;
  balanceRpcUrl?: string;
  balanceWalletAddress?: string;
  clobWsUrl?: string | null;
  clobApiKey?: string;
  clobApiSecret?: string;
  clobApiPassphrase?: string;
  monitorUserWsEnabled?: boolean;
  monitorContext?: EntryStrategyCoordinator | null;
  entrySymbol?: string;
  restBookTimeoutS?: number;
  balanceRefreshTimeoutS?: number;
  balanceForceRefreshMinS?: number;
}

export async function monitorOrderbookUntilEpochEnd(
  clobBaseUrl: string,
  yesTokenId: string,
  noTokenId: string,
  epochEnd: Date,
  options: MonitorOrderbookOptions = {},
): Promise<Record<string, unknown>> {
  const tag = options.tag || "";
  const pollIntervalS = options.pollIntervalS ?? 0.5;
  const marketLogIntervalS = options.marketLogIntervalS ?? 1.0;
  const monitorVerboseSecondsBeforeEnd = options.monitorVerboseSecondsBeforeEnd ?? 5.0;
  const strikeSpotFeed = options.strikeSpotFeed ?? null;

  let tpMode = (options.tradingProcessLogMode || "trades").trim().toLowerCase();
  if (tpMode !== "full" && tpMode !== "trades") {
    tpMode = "trades";
  }
  const tpTradesOnly = tpMode === "trades";

  let lastMarketLog = 0;
  let remYes = Math.max(0, options.splitInventoryYes ?? 0);
  let remNo = Math.max(0, options.splitInventoryNo ?? 0);
  const remState = { yes: remYes, no: remNo };

  let ogLine = "";
  if (strikeSpotFeed) {
    ogLine =
      `; strike_feed=${strikeSpotFeed.strike_provider}+spot=${strikeSpotFeed.spot_provider} ` +
      `(${strikeSpotFeed.symbol.toUpperCase()}-USD)`;
  }

  const userAuth = resolveClobWsAuth({
    apiKey: options.clobApiKey,
    apiSecret: options.clobApiSecret,
    apiPassphrase: options.clobApiPassphrase,
    clobClient: options.clobClient,
  });

  let userWsLine = "";
  if (options.monitorUserWsEnabled !== false && userAuth && (options.conditionId || "").trim()) {
    userWsLine = ` + user WS (api_key=${userAuth.apiKey.slice(0, 8)}...)`;
  } else if (options.monitorUserWsEnabled !== false && !userAuth) {
    userWsLine = " (user WS off: no valid CLOB API_KEY/SECRET/PASSPHRASE)";
  }
  console.log(
    `  ${tag} MONITOR (REST /book every ${pollIntervalS}s${userWsLine}${ogLine}) until epoch end`,
  );

  const smsEpochAvg = new SpotMinusStrikeEpochAverage();
  let lastTpMono = 0;

  const oracleAbort = new AbortController();
  let oracleTask: Promise<void> | null = null;
  const priceStore: Record<string, number> = {};
  let strike = 0;
  let productId: string | null = null;
  let lastStrikeSpotLog = 0;
  let spotLogKey = "spot";
  const needOracle =
    strikeSpotFeed != null &&
    ((options.logStrikeSpotIntervalS ?? 0) > 0 || Boolean(options.runStrikeSpotOracle));

  if (needOracle && strikeSpotFeed) {
    productId = `${strikeSpotFeed.symbol.toUpperCase()}-USD`;
    const fid = chainlinkFeedIdForSymbol(strikeSpotFeed.chainlink_feed_ids, strikeSpotFeed.symbol);
    const useChainlinkSpot = Boolean(
      strikeSpotFeed.chainlink_user_id &&
        strikeSpotFeed.chainlink_secret &&
        fid,
    );
    spotLogKey = "chainlink_spot";
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
      console.log(
        `  ${tag} spot: chainlink missing user/secret or feed_id for ${strikeSpotFeed.symbol}`,
      );
    }
    for (let i = 0; i < 50; i += 1) {
      if (priceStore[productId]) {
        break;
      }
      await sleep(100);
    }
    strike = await fetchEpochStrike(
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
    const spot0 = priceStore[productId];
    const sk = strike > 0 ? fmtStrikeSpotPrice(strike) : "—";
    const sp = spot0 && spot0 > 0 ? fmtStrikeSpotPrice(spot0) : "—";
    const sepTop = options.monitorWaveGate ? MONITOR_WAVE_SEP_OUTER : MONITOR_LOG_SEPARATOR;
    console.log(sepTop);
    console.log(
      `  ${tag} strike_spot init target=${sk} ${spotLogKey}=${sp} provider=${strikeSpotFeed.strike_provider}`,
    );
  }

  const balPollCfg =
    options.balancePollIntervalS != null ? Number(options.balancePollIntervalS) : 0;
  const balancePollIv = balPollCfg > 0 ? Math.max(0.05, balPollCfg) : 0;
  const showRemInventory = Boolean(
    options.paperAccount ||
      (options.clobClient && balancePollIv > 0) ||
      remYes > 0 ||
      remNo > 0,
  );
  let lastBalancePollMono = 0;
  let balanceLogOnce = true;

  const refreshRemBalances = async (): Promise<void> => {
    if (options.paperAccount) {
      options.paperAccount.advanceMonitorTick({ pollIntervalS });
      options.paperAccount.settlePending();
      const [ry, rn] = options.paperAccount.balances();
      remYes = ry;
      remNo = rn;
    } else if (options.clobClient) {
      const bal = await options.clobClient.fetchConditionalOutcomeBalancesShares(
        yesTokenId,
        noTokenId,
        {
          minPollS: balancePollIv,
          sync: false,
          conditionId: options.conditionId,
          logTag: balanceLogOnce ? tag.trim() : "",
          rpcUrl: options.balanceRpcUrl || undefined,
          walletAddress: options.balanceWalletAddress || undefined,
        },
      );
      balanceLogOnce = false;
      if (bal) {
        remYes = bal[0];
        remNo = bal[1];
      }
    }
    remState.yes = remYes;
    remState.no = remNo;
  };

  if (showRemInventory) {
    await refreshRemBalances();
    lastBalancePollMono = performance.now() / 1000;
  }

  const restTimeoutS = Math.max(0.5, options.restBookTimeoutS ?? 3.0);
  const balRefreshTimeoutS = Math.max(0.5, options.balanceRefreshTimeoutS ?? 3.0);
  const balForceMinS = Math.max(0.0, options.balanceForceRefreshMinS ?? 1.0);
  let lastForceBalanceMono = 0;
  let balanceTimeoutLogged = false;

  try {
    await withClobMonitorSession(
      {
        clobWsUrl: options.clobWsUrl,
        yesTokenId,
        noTokenId,
        conditionId: options.conditionId,
        userWsAuth: userAuth,
        userWsEnabled: options.monitorUserWsEnabled,
        tradingProcessPath: options.tradingProcessPath,
        tradingJournal: options.tradingJournal,
        tag,
        remainingSFn: () => Math.max(0, (epochEnd.getTime() - utcNow().getTime()) / 1000),
      },
      async (monitorBundle) => {
        const bookStore = monitorBundle.bookStore;
        const userStore = monitorBundle.userStore;
        const entrySym = String(options.entrySymbol || options.monitorGateSymbol || "")
          .toLowerCase()
          .trim();

        if (options.monitorContext && entrySym) {
          const entryRefreshBalances = async () => {
            await refreshRemBalances();
          };
          options.monitorContext.registerMarket(entrySym, {
            tag,
            yesTokenId,
            noTokenId,
            conditionId: options.conditionId,
            clobClient: options.clobClient,
            paperAccount: options.paperAccount,
            userStore,
            refreshBalances: entryRefreshBalances,
            tradingJournal: options.tradingJournal,
          });
        }

        while (utcNow() < epochEnd) {
          const remainingS = Math.max(0, (epochEnd.getTime() - utcNow().getTime()) / 1000);
          const nowMono = performance.now() / 1000;

          const ok = await pollBooksIntoStore(bookStore, yesTokenId, noTokenId, {
            baseUrl: clobBaseUrl,
            timeoutS: restTimeoutS,
          });
          if (!ok) {
            await sleep(pollIntervalS * 1000);
            continue;
          }

          const bookYes = bookStore.bookAsExecutorView(yesTokenId);
          const bookNo = bookStore.bookAsExecutorView(noTokenId);
          const bestBidYes = bestBidFromBook(bookYes);
          const bestBidNo = bestBidFromBook(bookNo);
          const bestAskYes = bestAskFromBook(bookYes);
          const bestAskNo = bestAskFromBook(bookNo);
          const depthMetrics = pairDepthMetricsForMonitor(bookYes, bookNo, { topN: 5 });
          const depthJsonl = depthMetricsForJsonl(depthMetrics);

          let spotThisRaw: number | undefined;
          if (strikeSpotFeed && productId) {
            spotThisRaw = priceStore[productId];
          }

          const tickStrike = strike > 0 ? strike : null;
          const tickSpot = spotForStrikeCompare(spotThisRaw);
          const smsValueTick = spotMinusStrikeUsd(tickStrike, tickSpot);
          const symForSms =
            options.monitorGateSymbol ||
            (strikeSpotFeed ? String(strikeSpotFeed.symbol).toLowerCase().trim() : "");
          const epochAvgValue = smsEpochAvg.record(smsValueTick);
          const avgSuffix = formatAverageSpotMinusForLog(symForSms, epochAvgValue);

          const ir = depthMetrics.influenceRate;
          const yir = depthMetrics.yesInfluenceRate;
          const nir = depthMetrics.noInfluenceRate;
          let tpLineForStdout: string | null = null;

          if (!tpTradesOnly && options.tradingProcessPath) {
            const infRow: Record<string, unknown> = {
              event: "INFLUENCE_TICK",
              ts_utc: utcIsoZ(),
              tag,
              t_minus_s: remainingS,
              ...depthJsonl,
            };
            if (options.monitorContext) {
              const [mx, mn] = options.monitorContext.btcWaveExtrema();
              if (mx != null) infRow.max_spot_minus_strike_btc = Math.round(mx * 1e4) / 1e4;
              if (mn != null) infRow.min_spot_minus_strike_btc = Math.round(mn * 1e4) / 1e4;
            }
            appendTradingJsonl(options.tradingProcessPath, infRow);
            const nowTp = performance.now() / 1000;
            const tpInterval = options.tradingProcessLogIntervalS ?? 0;
            if (tpInterval <= 0 || nowTp - lastTpMono >= tpInterval) {
              lastTpMono = nowTp;
              const tickRow: Record<string, unknown> = {
                event: "MONITOR_TICK",
                ts_utc: utcIsoZ(),
                tag,
                bid_yes: bestBidYes,
                bid_no: bestBidNo,
                sum_bids: bestBidYes + bestBidNo,
                t_minus_s: remainingS,
                rem_yes: remYes,
                rem_no: remNo,
                strike: tickStrike,
                spot: tickSpot,
                spot_minus_strike: spotMinusStrikeUsd(tickStrike, tickSpot),
                ...depthJsonl,
              };
              if (options.monitorContext) {
                const [mx, mn] = options.monitorContext.btcWaveExtrema();
                if (mx != null) tickRow.max_spot_minus_strike_btc = Math.round(mx * 1e4) / 1e4;
                if (mn != null) tickRow.min_spot_minus_strike_btc = Math.round(mn * 1e4) / 1e4;
              }
              appendTradingJsonl(options.tradingProcessPath, tickRow);
              if (options.tradingProcessLogStdout && !options.monitorWaveGate) {
                const sms = formatSpotMinusStrikeForLog(tickStrike, tickSpot);
                tpLineForStdout =
                  `  ${tag} [TRADING_PROCESS] t=${remainingS.toFixed(1)}s YES=${bestBidYes.toFixed(4)} ` +
                  `NO=${bestBidNo.toFixed(4)} sum=${(bestBidYes + bestBidNo).toFixed(4)} ` +
                  `inf=${ir.toFixed(4)} yes_ir=${yir.toFixed(4)} no_ir=${nir.toFixed(4)}${sms}`;
              }
            }
          }

          let remSuffix = remInventorySuffix(remYes, remNo, showRemInventory);
          if (options.paperAccount && options.paperAccount.pendingCount() > 0) {
            remSuffix += ` paper_pending=${options.paperAccount.pendingCount()}`;
          }
          const remTickSymSuffix = remInventoryMarketTickSuffix(
            options.monitorGateSymbol || "",
            remYes,
            remNo,
            showRemInventory,
          );

          const inVerbose =
            monitorVerboseSecondsBeforeEnd > 0 &&
            remainingS > 0 &&
            remainingS <= monitorVerboseSecondsBeforeEnd;

          if (options.monitorWaveGate && options.monitorGateSymbol) {
            let strikeLine: string | null = null;
            let influenceValue: number | null = null;
            const logStrikeIv = options.logStrikeSpotIntervalS ?? 0;
            if (strikeSpotFeed && productId && logStrikeIv > 0) {
              const spotCur = priceStore[productId];
              const spotCurCal = spotForStrikeCompare(spotCur);
              const ts = strike > 0 ? fmtStrikeSpotPrice(strike) : "—";
              const ss = spotCur && spotCur > 0 ? fmtStrikeSpotPrice(spotCur) : "—";
              const smsValue = spotMinusStrikeUsd(strike > 0 ? strike : null, spotCurCal);
              const sms = smsValue == null ? "—" : smsValue.toFixed(6);
              strikeLine =
                `${tag} [STRIKE_SPOT] target=${ts} ${spotLogKey}=${ss} ` +
                `spot_minus_strike_${options.monitorGateSymbol}=${sms}${avgSuffix}`;
            }
            influenceValue = ir;

            let marketLine = "";
            const bookPx = formatYesNoBookPrices(bestAskYes, bestBidYes, bestAskNo, bestBidNo);
            if (inVerbose) {
              marketLine = `  ${tag} [MARKET_TICK] ${bookPx}${remTickSymSuffix}`;
            } else if (nowMono - lastMarketLog >= marketLogIntervalS) {
              marketLine = `  ${tag} [MARKET_TICK] ${bookPx}${remTickSymSuffix}`;
              lastMarketLog = nowMono;
            } else if (remSuffix) {
              marketLine = `  ${tag} [REM]${remSuffix} ⏰t_minus=${remainingS.toFixed(2)}s`;
            }

            let maxSms: number | null = null;
            let minSms: number | null = null;
            if (options.monitorGateSymbol === "btc" && options.monitorContext) {
              options.monitorContext.updateBtcStrategyContext({
                spotMinusStrikeBtc: smsValueTick,
                avergeSpotMinusBtc: epochAvgValue,
                bestBidYes,
                bestBidNo,
                bestAskYes,
                bestAskNo,
              });
              [maxSms, minSms] = options.monitorContext.btcWaveExtrema();
            }
            await options.monitorWaveGate.submitWave(
              options.monitorGateSymbol,
              new MonitorWavePart({
                symbol: options.monitorGateSymbol,
                tMinusS: remainingS,
                maxSpotMinusStrikeBtc: maxSms,
                minSpotMinusStrikeBtc: minSms,
                strikeSpotLine: strikeLine,
                influenceValue,
                marketLine,
              }),
            );
          } else {
            const tickLines: string[] = [MONITOR_LOG_SEPARATOR];
            const logStrikeIv = options.logStrikeSpotIntervalS ?? 0;
            if (strikeSpotFeed && productId && logStrikeIv > 0) {
              if (nowMono - lastStrikeSpotLog >= logStrikeIv) {
                const spotCur = priceStore[productId];
                const spotCurCal = spotForStrikeCompare(spotCur);
                const ts = strike > 0 ? fmtStrikeSpotPrice(strike) : "—";
                const ss = spotCur && spotCur > 0 ? fmtStrikeSpotPrice(spotCur) : "—";
                const sms = formatSpotMinusStrikeForLog(strike > 0 ? strike : null, spotCurCal);
                tickLines.push(`  ${tag} [STRIKE_SPOT] target=${ts} ${spotLogKey}=${ss}${sms}${avgSuffix}`);
                lastStrikeSpotLog = nowMono;
              }
            }
            tickLines.push(
              `  ${tag} [INFLUENCE] ⏰t=${remainingS.toFixed(2)}s inf=${ir.toFixed(6)} yes_ir=${yir.toFixed(6)} no_ir=${nir.toFixed(6)}`,
            );
            if (tpLineForStdout) {
              tickLines.push(tpLineForStdout);
            }
            if (inVerbose) {
              let tickExtra = "";
              if (strikeSpotFeed && productId) {
                const ts = strike > 0 ? fmtStrikeSpotPrice(strike) : "—";
                const spUsed = tickSpot != null ? fmtStrikeSpotPrice(tickSpot) : "—";
                tickExtra = ` strike=${ts} spot=${spUsed}`;
                tickExtra += formatSpotMinusStrikeForLog(tickStrike, tickSpot);
              }
              const bookPx = formatYesNoBookPrices(bestAskYes, bestBidYes, bestAskNo, bestBidNo);
              tickLines.push(
                `  ${tag} [MARKET_TICK] ${bookPx} ⏰t_minus=${remainingS.toFixed(2)}s${tickExtra}${remSuffix}`,
              );
            } else if (nowMono - lastMarketLog >= marketLogIntervalS) {
              const smsM = formatSpotMinusStrikeForLog(tickStrike, tickSpot);
              const bookPx = formatYesNoBookPrices(bestAskYes, bestBidYes, bestAskNo, bestBidNo);
              tickLines.push(
                `  ${tag} [MARKET] ${bookPx} ⏰t_minus=${remainingS.toFixed(1)}s${remSuffix}${smsM}`,
              );
              lastMarketLog = nowMono;
            } else if (remSuffix) {
              tickLines.push(`  ${tag} [REM]${remSuffix} ⏰t_minus=${remainingS.toFixed(2)}s`);
            }
            for (const ln of tickLines) {
              console.log(ln);
            }
          }

          if (showRemInventory) {
            let forceBal = false;
            if (userStore?.consumeBalanceRefresh()) {
              if (nowMono - lastForceBalanceMono >= balForceMinS) {
                forceBal = true;
                lastForceBalanceMono = nowMono;
              }
            }
            if (balancePollIv > 0 && (forceBal || nowMono - lastBalancePollMono >= balancePollIv)) {
              try {
                await Promise.race([
                  refreshRemBalances(),
                  sleep(balRefreshTimeoutS * 1000).then(() => {
                    throw new Error("timeout");
                  }),
                ]);
              } catch (e) {
                if (!balanceTimeoutLogged && String(e).includes("timeout")) {
                  balanceTimeoutLogged = true;
                  console.log(
                    `  ${tag} [BALANCE] refresh timed out after ${balRefreshTimeoutS}s (using last rem_*)`,
                  );
                }
              }
              lastBalancePollMono = nowMono;
            }
          }

          if (options.paperAccount) {
            options.paperAccount.advanceMonitorTick({ pollIntervalS });
            options.paperAccount.settlePending();
            const [ry, rn] = options.paperAccount.balances();
            remYes = ry;
            remNo = rn;
            remState.yes = remYes;
            remState.no = remNo;
          }

          if (options.monitorContext && entrySym) {
            await options.monitorContext.onMonitorTick(entrySym, {
              remainingS,
              remYes,
              remNo,
              bestBidYes,
              bestBidNo,
              bestAskYes,
              bestAskNo,
              spotMinusStrike: smsValueTick,
              avergeSpotMinusBtc: entrySym === "btc" ? epochAvgValue : null,
            });
          }

          await sleep(pollIntervalS * 1000);
        }

        if (options.monitorContext && entrySym) {
          options.monitorContext.unregisterMarket(entrySym);
        }
      },
    );
  } finally {
    oracleAbort.abort();
    if (oracleTask) {
      await Promise.race([oracleTask.catch(() => undefined), sleep(5000)]);
    }
  }

  console.log(`  ${tag} [MONITOR_END] epoch end reached`);
  if (options.tradingProcessPath && !tpTradesOnly) {
    appendTradingJsonl(options.tradingProcessPath, {
      event: "MONITOR_END",
      ts_utc: utcIsoZ(),
      tag,
    });
  }
  return {};
}
