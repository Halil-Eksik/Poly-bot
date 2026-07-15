/** buy1 / buy2 entry logic and risk1 / risk2 / risk3 exits. */

import type {
  Buy1Config,
  Buy2Config,
  Buy3Config,
  Buy4Config,
  Risk1Config,
  Risk2Config,
  Risk3Config,
  Settings,
} from "../config.js";
import type { UserChannelStore } from "../data/userChannelStore.js";
import {
  BtcStrategySnapshot,
  SpotMinusStrikeEpochAverage,
  enrichStrategyRowTMinus,
  formatTMinusSuffix,
  strategyPhaseFromEvent,
  type TradingCycleJournal,
} from "../tradingProcessLog.js";
import type { ClobClient } from "./clobClient.js";
import type { PaperV2Account } from "./paperExchange.js";

export const ENTRY_PAIR_SYMBOLS = ["btc", "eth"] as const;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const FAK_NO_MATCH_ERR_MARKER = "no orders found to match with FAK order";

function isFakNoMatchError(err: string): boolean {
  return (err || "").includes(FAK_NO_MATCH_ERR_MARKER);
}

function clampBuyPrice(price: number): number {
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, Math.round(price * 10000) / 10000));
}

function clampSellPrice(bestBid: number, offset: number): number {
  return Math.max(MIN_PRICE, Math.round((bestBid - offset) * 10000) / 10000);
}

function inTimeWindow(remainingS: number, lo: number, hi: number): boolean {
  return lo <= remainingS && remainingS <= hi;
}

function passesSignAlignment(
  spotMinusStrikeBtc: number,
  avergeSpotMinusBtc: number,
  spotMinusStrikeEth: number,
): boolean {
  if (spotMinusStrikeBtc > 0) {
    return avergeSpotMinusBtc > 0 && spotMinusStrikeEth > 0;
  }
  if (spotMinusStrikeBtc < 0) {
    return avergeSpotMinusBtc < 0 && spotMinusStrikeEth < 0;
  }
  return false;
}

export class PositionState {
  outcome = "";
  entryLabel = "";
  fillPrice = 0;
  orderPrice = 0;
  targetShares = 0;
  filledShares = 0;
  pendingOrder = false;
  fillConfirmed = false;
  closed = false;
  firstMatchMono: number | null = null;
  risk1Cycles = 0;
  risk3Cycles = 0;
  exitBusy = false;
  exitReason = "";
  sellAttempts = 0;
  baselineRemYes = 0;
  baselineRemNo = 0;
  tradesSeen = 0;
  /** Opposite-leg hedge (buy3/buy4) after first leg fills. */
  pairHedgePending = false;
  pairHedgeDone = false;
  pairHedgeOutcome = "";
  pairHedgeBaselineRemYes = 0;
  pairHedgeBaselineRemNo = 0;
}

export class MarketSlot {
  symbol: string;
  tag: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId = "";
  clobClient: ClobClient | null = null;
  paperAccount: PaperV2Account | null = null;
  userStore: UserChannelStore | null = null;
  refreshBalances: (() => Promise<void>) | null = null;
  tradingJournal: TradingCycleJournal | null = null;
  remainingS = 0;
  bestBidYes = 0;
  bestBidNo = 0;
  bestAskYes = 0;
  bestAskNo = 0;
  remYes = 0;
  remNo = 0;
  spotMinusStrike: number | null = null;
  position = new PositionState();
  strategyLogExtras: Record<string, unknown> = {};
  activeTask: Promise<void> | null = null;

  constructor(fields: {
    symbol: string;
    tag: string;
    yesTokenId: string;
    noTokenId: string;
    conditionId?: string;
    clobClient?: ClobClient | null;
    paperAccount?: PaperV2Account | null;
    userStore?: UserChannelStore | null;
    refreshBalances?: (() => Promise<void>) | null;
    tradingJournal?: TradingCycleJournal | null;
  }) {
    this.symbol = fields.symbol;
    this.tag = fields.tag;
    this.yesTokenId = fields.yesTokenId;
    this.noTokenId = fields.noTokenId;
    this.conditionId = fields.conditionId ?? "";
    this.clobClient = fields.clobClient ?? null;
    this.paperAccount = fields.paperAccount ?? null;
    this.userStore = fields.userStore ?? null;
    this.refreshBalances = fields.refreshBalances ?? null;
    this.tradingJournal = fields.tradingJournal ?? null;
  }
}

class EntryStrategyState {
  done = false;
  lockedOutcome = "";
  yesCycles = 0;
  noCycles = 0;
  busy = false;
}

function bestBidForOutcome(slot: MarketSlot, outcome: string): number {
  return outcome.toUpperCase() === "YES" ? slot.bestBidYes : slot.bestBidNo;
}

function bestAskForOutcome(slot: MarketSlot, outcome: string): number {
  return outcome.toUpperCase() === "YES" ? slot.bestAskYes : slot.bestAskNo;
}

function outcomeTokenId(slot: MarketSlot, outcome: string): string {
  return outcome.toUpperCase() === "YES" ? slot.yesTokenId : slot.noTokenId;
}

function oppositeOutcome(outcome: string): string {
  return outcome.toUpperCase() === "YES" ? "NO" : "YES";
}

function log(tag: string, msg: string, slot?: MarketSlot | null, remainingS?: number | null): void {
  const t = remainingS ?? slot?.remainingS;
  console.log(`  ${tag} ${msg}${formatTMinusSuffix(t)}`);
}

function jsonl(slot: MarketSlot, row: Record<string, unknown>): void {
  if (!slot.tradingJournal) return;
  let out = { ...row };
  const ev = String(out.event ?? "");
  const phase = strategyPhaseFromEvent(ev);
  if (phase && !("strategy" in out)) {
    out = { ...out, strategy: phase };
  }
  out = enrichStrategyRowTMinus(out, { remainingS: slot.remainingS });
  slot.tradingJournal.appendStrategy({ ...slot.strategyLogExtras, ...out });
}

/** BTC wave context + buy1/buy2 entries + risk1/risk2/risk3 exits. */
export class EntryStrategyCoordinator {
  private readonly buy1: Buy1Config;
  private readonly buy2: Buy2Config;
  private readonly buy3: Buy3Config;
  private readonly buy4: Buy4Config;
  private readonly risk1: Risk1Config;
  private readonly risk2: Risk2Config;
  private readonly risk3: Risk3Config;
  private readonly epsilon: number;
  private readonly slots = new Map<string, MarketSlot>();
  private readonly btcSnapshot = new BtcStrategySnapshot();
  private readonly btcSmsAvg = new SpotMinusStrikeEpochAverage();
  private buy1State = new EntryStrategyState();
  private buy2State = new EntryStrategyState();
  private buy3State = new EntryStrategyState();
  private buy4State = new EntryStrategyState();
  private readonly buyBlockedSymbols = new Set<string>();
  private lock: Promise<void> = Promise.resolve();

  constructor(settings: Settings) {
    this.buy1 = settings.buy1;
    this.buy2 = settings.buy2;
    this.buy3 = settings.buy3;
    this.buy4 = settings.buy4;
    this.risk1 = settings.risk1;
    this.risk2 = settings.risk2;
    this.risk3 = settings.risk3;
    this.epsilon = Math.max(0, settings.execution.balance_epsilon ?? 0.01);
  }

  resetBtcEpochStats(): void {
    this.btcSnapshot.resetEpoch();
    this.buy1State = new EntryStrategyState();
    this.buy2State = new EntryStrategyState();
    this.buy3State = new EntryStrategyState();
    this.buy4State = new EntryStrategyState();
    this.buyBlockedSymbols.clear();
    for (const slot of this.slots.values()) {
      slot.position = new PositionState();
    }
  }

  private refreshSlotStrategyExtras(): void {
    const extras = this.btcSnapshot.asLogFields();
    for (const slot of this.slots.values()) {
      slot.strategyLogExtras = extras;
    }
  }

  updateBtcStrategyContext(fields: {
    spotMinusStrikeBtc?: number | null;
    avergeSpotMinusBtc?: number | null;
    differenceRateBtc?: number | null;
    bestBidYes?: number;
    bestBidNo?: number;
    bestAskYes?: number;
    bestAskNo?: number;
  }): void {
    const snap = this.btcSnapshot;
    if (fields.spotMinusStrikeBtc != null) {
      snap.spotMinusStrikeBtc = fields.spotMinusStrikeBtc;
      snap.recordSpotMinusStrikeBtc(snap.spotMinusStrikeBtc);
    }
    if (fields.avergeSpotMinusBtc != null) {
      snap.avergeSpotMinusBtc = fields.avergeSpotMinusBtc;
    }
    if (fields.differenceRateBtc != null) {
      snap.differenceRateBtc = fields.differenceRateBtc;
    }
    if ((fields.bestBidYes ?? 0) > 0) snap.yesBestBid = fields.bestBidYes!;
    if ((fields.bestBidNo ?? 0) > 0) snap.noBestBid = fields.bestBidNo!;
    if ((fields.bestAskYes ?? 0) > 0) snap.yesBestAsk = fields.bestAskYes!;
    if ((fields.bestAskNo ?? 0) > 0) snap.noBestAsk = fields.bestAskNo!;
    this.refreshSlotStrategyExtras();
  }

  btcWaveExtrema(): [number | null, number | null] {
    return [this.btcSnapshot.maxSpotMinusStrikeBtc, this.btcSnapshot.minSpotMinusStrikeBtc];
  }

  registerMarket(
    symbol: string,
    fields: {
      tag: string;
      yesTokenId: string;
      noTokenId: string;
      conditionId?: string;
      clobClient?: ClobClient | null;
      paperAccount?: PaperV2Account | null;
      userStore?: UserChannelStore | null;
      refreshBalances?: (() => Promise<void>) | null;
      tradingJournal?: TradingCycleJournal | null;
    },
  ): void {
    const sym = symbol.toLowerCase().trim();
    this.slots.set(
      sym,
      new MarketSlot({
        symbol: sym,
        ...fields,
      }),
    );
    this.refreshSlotStrategyExtras();
  }

  unregisterMarket(symbol: string): void {
    this.slots.delete(symbol.toLowerCase().trim());
  }

  private avergeSpotMinusBtc(): number | null {
    return this.btcSmsAvg.average() ?? this.btcSnapshot.avergeSpotMinusBtc;
  }

  private spotMinusStrikeBtc(): number | null {
    return this.btcSnapshot.spotMinusStrikeBtc;
  }

  private spotMinusStrikeEth(): number | null {
    return this.slots.get("eth")?.spotMinusStrike ?? null;
  }

  private refRemainingS(): number {
    const vals = ENTRY_PAIR_SYMBOLS.filter((s) => this.slots.has(s)).map(
      (s) => this.slots.get(s)!.remainingS,
    );
    return vals.length ? Math.min(...vals) : 0;
  }

  private symbolBuyBlocked(symbol: string): boolean {
    return this.buyBlockedSymbols.has(symbol.toLowerCase().trim());
  }

  private blockSymbolBuys(symbol: string): void {
    this.buyBlockedSymbols.add(symbol.toLowerCase().trim());
  }

  private positionShares(slot: MarketSlot, pos: PositionState): number {
    if (!pos.outcome) return 0;
    if (pos.outcome.toUpperCase() === "YES") {
      return Math.max(0, slot.remYes - pos.baselineRemYes);
    }
    return Math.max(0, slot.remNo - pos.baselineRemNo);
  }

  private ingestBuyFills(slot: MarketSlot): void {
    const pos = slot.position;
    if (!pos.pendingOrder && !pos.fillConfirmed) return;

    const store = slot.userStore;
    if (store && pos.outcome) {
      const tokenId = outcomeTokenId(slot, pos.outcome);
      const n = store.trades.length;
      if (n > pos.tradesSeen) {
        const newTrades = store.trades.slice(pos.tradesSeen);
        pos.tradesSeen = n;
        let notional = pos.filledShares * (pos.fillPrice || pos.orderPrice || 0);
        let shares = pos.filledShares;
        for (const raw of newTrades) {
          const row = store.tradeRowForLog(raw);
          if (String(row.side ?? "").toUpperCase() !== "BUY") continue;
          if (String(raw.asset_id ?? "") !== String(tokenId).trim()) continue;
          const status = String(row.status ?? "").toUpperCase();
          if (!["MATCHED", "MINED", "CONFIRMED"].includes(status)) continue;
          const px = Number(row.price ?? 0);
          const sz = Number(row.size ?? 0);
          if (sz <= 0 || px <= 0) continue;
          notional += px * sz;
          shares += sz;
        }
        if (shares > 0) {
          pos.filledShares = shares;
          pos.fillPrice = notional / shares;
        }
      }
    }

    if (this.positionShares(slot, pos) > this.epsilon) {
      if (!pos.fillConfirmed) {
        pos.fillConfirmed = true;
        pos.pendingOrder = false;
        pos.firstMatchMono = performance.now() / 1000;
        if (pos.fillPrice <= 0) pos.fillPrice = pos.orderPrice || 0;
        log(
          slot.tag,
          `[${pos.entryLabel}_FILL] outcome=${pos.outcome} fill_px=${pos.fillPrice.toFixed(4)} fill_sz=${pos.filledShares.toFixed(4)}`,
          slot,
        );
        jsonl(slot, {
          event: `${pos.entryLabel}_FILL`,
          buy_outcome: pos.outcome,
          filled_price: pos.fillPrice,
          filled_shares: pos.filledShares,
          rem_yes: slot.remYes,
          rem_no: slot.remNo,
        });
      }
    }
  }

  private pairHedgeShares(slot: MarketSlot, pos: PositionState): number {
    if (!pos.pairHedgeOutcome) return 0;
    if (pos.pairHedgeOutcome.toUpperCase() === "YES") {
      return Math.max(0, slot.remYes - pos.pairHedgeBaselineRemYes);
    }
    return Math.max(0, slot.remNo - pos.pairHedgeBaselineRemNo);
  }

  private ingestPairHedgeFills(slot: MarketSlot): void {
    const pos = slot.position;
    if (!pos.pairHedgePending || pos.pairHedgeDone || !pos.pairHedgeOutcome) return;

    const store = slot.userStore;
    if (store && pos.pairHedgeOutcome) {
      const tokenId = outcomeTokenId(slot, pos.pairHedgeOutcome);
      const label = pos.entryLabel === "BUY1" ? "BUY3" : pos.entryLabel === "BUY2" ? "BUY4" : "";
      if (!label) return;
      const n = store.trades.length;
      if (n > pos.tradesSeen) {
        for (const raw of store.trades.slice(pos.tradesSeen)) {
          const row = store.tradeRowForLog(raw);
          if (String(row.side ?? "").toUpperCase() !== "BUY") continue;
          if (String(raw.asset_id ?? "") !== String(tokenId).trim()) continue;
          const status = String(row.status ?? "").toUpperCase();
          if (!["MATCHED", "MINED", "CONFIRMED"].includes(status)) continue;
        }
      }
    }

    if (this.pairHedgeShares(slot, pos) > this.epsilon) {
      pos.pairHedgeDone = true;
      pos.pairHedgePending = false;
      const label = pos.entryLabel === "BUY1" ? "BUY3" : "BUY4";
      log(
        slot.tag,
        `[${label}_FILL] outcome=${pos.pairHedgeOutcome} pair boxed rem_YES=${slot.remYes.toFixed(4)} rem_NO=${slot.remNo.toFixed(4)}`,
        slot,
      );
      jsonl(slot, {
        event: `${label}_FILL`,
        buy_outcome: pos.pairHedgeOutcome,
        first_leg_outcome: pos.outcome,
        first_leg_fill_price: pos.fillPrice,
        rem_yes: slot.remYes,
        rem_no: slot.remNo,
      });
    }
  }

  private pairHedgeTriggerOk(
    slot: MarketSlot,
    pos: PositionState,
    cfg: Buy3Config | Buy4Config,
  ): { opposite: string; oppositeAsk: number; limitPrice: number; sum: number } | null {
    if (!cfg.enabled || !pos.fillConfirmed || pos.closed || pos.pairHedgeDone || pos.pairHedgePending) {
      return null;
    }
    if (pos.fillPrice <= 0) return null;
    const opposite = oppositeOutcome(pos.outcome);
    const oppositeAsk = bestAskForOutcome(slot, opposite);
    if (oppositeAsk <= 0) return null;
    const sum = pos.fillPrice + oppositeAsk;
    if (sum >= cfg.pair_sum_max) return null;
    const limitPrice = clampBuyPrice(oppositeAsk + cfg.opposite_buy_offset);
    return { opposite, oppositeAsk, limitPrice, sum };
  }

  private async evaluatePairHedge(
    slot: MarketSlot,
    cfg: Buy3Config | Buy4Config,
    label: string,
    requiredEntryLabel: string,
    state: EntryStrategyState,
  ): Promise<void> {
    if (state.done || state.busy) return;
    const pos = slot.position;
    if (pos.entryLabel !== requiredEntryLabel || !pos.fillConfirmed) return;
    if (slot.activeTask) return;

    const trigger = this.pairHedgeTriggerOk(slot, pos, cfg);
    if (!trigger) return;

    state.busy = true;
    slot.activeTask = this.runPairBuy(slot, trigger, label, cfg, state, pos.filledShares);
  }

  private async runPairBuy(
    slot: MarketSlot,
    trigger: { opposite: string; oppositeAsk: number; limitPrice: number; sum: number },
    label: string,
    cfg: Buy3Config | Buy4Config,
    state: EntryStrategyState,
    size: number,
  ): Promise<void> {
    const pos = slot.position;
    try {
      const orderType = (cfg.order_type || "GTC").toUpperCase();
      const tokenId = outcomeTokenId(slot, trigger.opposite);
      log(
        slot.tag,
        `[${label}] trigger opposite=${trigger.opposite} first_fill=${pos.fillPrice.toFixed(4)} ` +
          `opp_ask=${trigger.oppositeAsk.toFixed(4)} sum=${trigger.sum.toFixed(4)} ` +
          `limit_px=${trigger.limitPrice.toFixed(4)} sz=${size.toFixed(4)} type=${orderType}`,
        slot,
      );
      jsonl(slot, {
        event: `${label}_TRIGGER`,
        buy_outcome: trigger.opposite,
        first_leg_outcome: pos.outcome,
        first_leg_fill_price: pos.fillPrice,
        opposite_best_ask: trigger.oppositeAsk,
        pair_sum: trigger.sum,
        pair_sum_max: cfg.pair_sum_max,
        buy_limit_price: trigger.limitPrice,
        order_type: orderType,
        shares: size,
      });

      const [placed, orderErr] = await this.placeLimitBuy(
        slot,
        tokenId,
        trigger.limitPrice,
        size,
        trigger.opposite,
        orderType,
        label,
      );

      if (placed) {
        state.done = true;
        pos.pairHedgePending = true;
        pos.pairHedgeOutcome = trigger.opposite.toUpperCase();
        pos.pairHedgeBaselineRemYes = slot.remYes;
        pos.pairHedgeBaselineRemNo = slot.remNo;
        if (slot.refreshBalances) await slot.refreshBalances();
        this.ingestPairHedgeFills(slot);
        log(slot.tag, `[${label}_ORDER] outcome=${trigger.opposite} sz=${size.toFixed(4)} awaiting fill`, slot);
        jsonl(slot, {
          event: `${label}_ORDER`,
          buy_outcome: trigger.opposite,
          price: trigger.limitPrice,
          size,
          order_type: orderType,
        });
      } else {
        state.done = true;
        log(slot.tag, `[${label}_ABORT] reason=order_rejected err=${orderErr}`, slot);
        jsonl(slot, {
          event: `${label}_ABORT`,
          buy_outcome: trigger.opposite,
          reason: "order_rejected",
          error: orderErr,
        });
      }
    } finally {
      state.busy = false;
      slot.activeTask = null;
    }
  }

  private sideBookOk(
    slot: MarketSlot,
    outcome: string,
    maxSpread: number,
    minBestAsk: number,
  ): boolean {
    const bid = bestBidForOutcome(slot, outcome);
    const ask = bestAskForOutcome(slot, outcome);
    if (bid <= 0 || ask <= 0) return false;
    if (ask - bid >= maxSpread) return false;
    return ask > minBestAsk;
  }

  private globalGatesOk(
    cfg: Buy1Config | Buy2Config,
    smsBtc: number,
    avgBtc: number,
    smsEth: number,
  ): boolean {
    if (Math.abs(smsBtc) <= cfg.spot_minus_strike_btc_abs_min) return false;
    if (Math.abs(avgBtc) <= cfg.averge_spot_minus_btc_abs_min) return false;
    if (Math.abs(smsEth) <= cfg.spot_minus_strike_eth_abs_min) return false;
    return passesSignAlignment(smsBtc, avgBtc, smsEth);
  }

  private buy1SideOk(outcome: string): boolean {
    if (!this.buy1.enabled || this.symbolBuyBlocked("btc")) return false;
    const btc = this.slots.get("btc");
    const eth = this.slots.get("eth");
    if (!btc || !eth) return false;
    if (btc.position.pendingOrder || (btc.position.fillConfirmed && !btc.position.closed)) {
      return false;
    }
    const smsBtc = this.spotMinusStrikeBtc();
    const avgBtc = this.avergeSpotMinusBtc();
    const smsEth = this.spotMinusStrikeEth();
    if (smsBtc == null || avgBtc == null || smsEth == null) return false;
    if (!this.globalGatesOk(this.buy1, smsBtc, avgBtc, smsEth)) return false;
    if (!this.sideBookOk(btc, outcome, this.buy1.max_spread, this.buy1.min_best_ask)) {
      return false;
    }
    return bestBidForOutcome(eth, outcome) > this.buy1.other_symbol_min_best_bid;
  }

  private buy2SideOk(outcome: string): boolean {
    if (!this.buy2.enabled || this.symbolBuyBlocked("eth")) return false;
    const btc = this.slots.get("btc");
    const eth = this.slots.get("eth");
    if (!btc || !eth) return false;
    if (eth.position.pendingOrder || (eth.position.fillConfirmed && !eth.position.closed)) {
      return false;
    }
    const smsBtc = this.spotMinusStrikeBtc();
    const avgBtc = this.avergeSpotMinusBtc();
    const smsEth = this.spotMinusStrikeEth();
    if (smsBtc == null || avgBtc == null || smsEth == null) return false;
    if (!this.globalGatesOk(this.buy2, smsBtc, avgBtc, smsEth)) return false;
    if (!this.sideBookOk(eth, outcome, this.buy2.max_spread, this.buy2.min_best_ask)) {
      return false;
    }
    return bestBidForOutcome(btc, outcome) > this.buy2.other_symbol_min_best_bid;
  }

  private tickStrategy(
    state: EntryStrategyState,
    cfg: Buy1Config | Buy2Config,
    sideOkFn: (outcome: string) => boolean,
    remainingS: number,
    lo: number,
    hi: number,
  ): string | null {
    if (state.done) return null;
    if (!inTimeWindow(remainingS, lo, hi)) {
      state.yesCycles = 0;
      state.noCycles = 0;
      return null;
    }
    const need = Math.max(1, cfg.monitoring_cycles);
    if (state.lockedOutcome) {
      return sideOkFn(state.lockedOutcome) ? state.lockedOutcome : null;
    }
    if (sideOkFn("YES")) state.yesCycles += 1;
    else state.yesCycles = 0;
    if (sideOkFn("NO")) state.noCycles += 1;
    else state.noCycles = 0;
    if (state.yesCycles >= need) {
      state.lockedOutcome = "YES";
      return "YES";
    }
    if (state.noCycles >= need) {
      state.lockedOutcome = "NO";
      return "NO";
    }
    return null;
  }

  private sellOffsetForReason(reason: string): number {
    if (reason === "risk1") return this.risk1.sell_offset;
    if (reason === "risk2") return this.risk2.sell_offset;
    if (reason === "risk3") return this.risk3.sell_offset;
    return 0.05;
  }

  private maxSellAttemptsForReason(reason: string): number {
    if (reason === "risk1") return Math.max(1, this.risk1.max_sell_attempts);
    if (reason === "risk2") return Math.max(1, this.risk2.max_sell_attempts);
    if (reason === "risk3") return Math.max(1, this.risk3.max_sell_attempts);
    return 5;
  }

  private pickRiskExitReason(slot: MarketSlot, pos: PositionState): string | null {
    const outcome = pos.outcome;
    if (!outcome) return null;
    const rem = this.positionShares(slot, pos);
    if (rem <= this.epsilon) return null;
    const bid = bestBidForOutcome(slot, outcome);
    const nowMono = performance.now() / 1000;

    if (this.risk1.enabled && pos.fillPrice > 0 && bid > 0) {
      const threshold = pos.fillPrice - this.risk1.loss_offset;
      if (bid < threshold) pos.risk1Cycles += 1;
      else pos.risk1Cycles = 0;
      if (pos.risk1Cycles >= Math.max(1, this.risk1.monitoring_cycles)) return "risk1";
    }

    if (this.risk2.enabled && pos.firstMatchMono != null) {
      if (performance.now() / 1000 - pos.firstMatchMono >= this.risk2.hold_timeout_sec && rem > this.epsilon) {
        return "risk2";
      }
    }

    if (this.risk3.enabled && bid > 0) {
      if (bid < this.risk3.bid_below) pos.risk3Cycles += 1;
      else pos.risk3Cycles = 0;
      if (pos.risk3Cycles >= Math.max(1, this.risk3.monitoring_cycles)) return "risk3";
    }
    return null;
  }

  private async evaluateRiskExits(slot: MarketSlot): Promise<void> {
    const pos = slot.position;
    if (!pos.fillConfirmed || pos.closed) return;
    if (pos.pairHedgeDone) return;
    if (slot.activeTask) return;

    if (slot.refreshBalances) await slot.refreshBalances();

    const outcome = pos.outcome;
    let rem = this.positionShares(slot, pos);
    if (rem <= this.epsilon) {
      pos.closed = true;
      return;
    }

    const bid = bestBidForOutcome(slot, outcome);

    if (pos.exitBusy) {
      const reason = pos.exitReason || "risk1";
      const maxAttempts = this.maxSellAttemptsForReason(reason);
      if (pos.sellAttempts >= maxAttempts) {
        pos.exitBusy = false;
        return;
      }
      const sellOffset = this.sellOffsetForReason(reason);
      pos.sellAttempts += 1;
      const sellPx = bid > 0 ? clampSellPrice(bid, sellOffset) : MIN_PRICE;
      const label = reason.toUpperCase();
      log(
        slot.tag,
        `[${label}_RETRY] sell_outcome=${outcome} rem=${rem.toFixed(4)} px=${sellPx.toFixed(4)} attempt=${pos.sellAttempts}/${maxAttempts}`,
        slot,
      );
      const ok = await this.placeLimitSell(slot, outcome, sellPx, rem, label, pos.sellAttempts);
      if (!ok) jsonl(slot, { event: `${label}_RETRY_FAIL`, sell_outcome: outcome });
      if (slot.refreshBalances) await slot.refreshBalances();
      if (this.positionShares(slot, pos) <= this.epsilon) await this.finishRiskExit(slot, reason);
      return;
    }

    const reason = this.pickRiskExitReason(slot, pos);
    if (!reason) return;

    const maxAttempts = this.maxSellAttemptsForReason(reason);
    if (pos.sellAttempts >= maxAttempts) return;

    const sellOffset = this.sellOffsetForReason(reason);
    pos.exitBusy = true;
    pos.exitReason = reason;
    pos.sellAttempts += 1;
    const sellPx = bid > 0 ? clampSellPrice(bid, sellOffset) : MIN_PRICE;
    const label = reason.toUpperCase();
    log(
      slot.tag,
      `[${label}] trigger sell_outcome=${outcome} rem=${rem.toFixed(4)} px=${sellPx.toFixed(4)} attempt=${pos.sellAttempts}/${maxAttempts} fill_px=${pos.fillPrice.toFixed(4)}`,
      slot,
    );
    jsonl(slot, {
      event: `${label}_TRIGGER`,
      sell_outcome: outcome,
      rem_shares: rem,
      sell_price: sellPx,
      attempt: pos.sellAttempts,
      max_attempts: maxAttempts,
      filled_price: pos.fillPrice,
      best_bid: bid,
      rem_yes: slot.remYes,
      rem_no: slot.remNo,
    });
    const ok = await this.placeLimitSell(slot, outcome, sellPx, rem, label, pos.sellAttempts);
    if (!ok) jsonl(slot, { event: `${label}_FAIL`, sell_outcome: outcome });
    if (slot.refreshBalances) await slot.refreshBalances();
    if (this.positionShares(slot, pos) <= this.epsilon) await this.finishRiskExit(slot, reason);
  }

  private async finishRiskExit(slot: MarketSlot, reason: string): Promise<void> {
    const pos = slot.position;
    const label = reason.toUpperCase();
    pos.exitBusy = false;
    pos.closed = true;
    pos.risk1Cycles = 0;
    pos.risk3Cycles = 0;
    this.blockSymbolBuys(slot.symbol);
    log(
      slot.tag,
      `[${label}_DONE] sell_outcome=${pos.outcome} rem_YES=${slot.remYes.toFixed(4)} rem_NO=${slot.remNo.toFixed(4)} (no more buys this epoch)`,
      slot,
    );
    jsonl(slot, {
      event: `${label}_DONE`,
      sell_outcome: pos.outcome,
      rem_yes: slot.remYes,
      rem_no: slot.remNo,
    });
  }

  async onMonitorTick(
    symbol: string,
    fields: {
      remainingS: number;
      remYes: number;
      remNo: number;
      bestBidYes: number;
      bestBidNo: number;
      bestAskYes?: number;
      bestAskNo?: number;
      spotMinusStrike?: number | null;
      spotMinusStrikeBtc?: number | null;
      avergeSpotMinusBtc?: number | null;
      differenceRateBtc?: number | null;
    },
  ): Promise<void> {
    const sym = symbol.toLowerCase().trim();
    const slot = this.slots.get(sym);
    if (!slot) return;

    slot.remainingS = fields.remainingS;
    slot.remYes = fields.remYes;
    slot.remNo = fields.remNo;
    slot.bestBidYes = fields.bestBidYes;
    slot.bestBidNo = fields.bestBidNo;
    slot.bestAskYes = fields.bestAskYes ?? 0;
    slot.bestAskNo = fields.bestAskNo ?? 0;

    const sms = fields.spotMinusStrike ?? fields.spotMinusStrikeBtc;
    if (sms != null) slot.spotMinusStrike = sms;

    if (sym === "btc") {
      let avg = fields.avergeSpotMinusBtc;
      if (sms != null) avg = this.btcSmsAvg.record(sms) ?? avg;
      this.updateBtcStrategyContext({
        spotMinusStrikeBtc: sms,
        avergeSpotMinusBtc: avg,
        differenceRateBtc: fields.differenceRateBtc,
        bestBidYes: slot.bestBidYes,
        bestBidNo: slot.bestBidNo,
        bestAskYes: slot.bestAskYes,
        bestAskNo: slot.bestAskNo,
      });
    }

    this.ingestBuyFills(slot);

    if (!(ENTRY_PAIR_SYMBOLS as readonly string[]).includes(sym)) return;
    if (!this.slots.has("btc") || !this.slots.has("eth")) return;

    await this.withLock(async () => {
      for (const s of ENTRY_PAIR_SYMBOLS) {
        const sl = this.slots.get(s);
        if (sl) {
          this.ingestBuyFills(sl);
          this.ingestPairHedgeFills(sl);
        }
      }
      const btcSlot = this.slots.get("btc");
      const ethSlot = this.slots.get("eth");
      if (btcSlot) await this.evaluatePairHedge(btcSlot, this.buy3, "BUY3", "BUY1", this.buy3State);
      if (ethSlot) await this.evaluatePairHedge(ethSlot, this.buy4, "BUY4", "BUY2", this.buy4State);
      for (const s of ENTRY_PAIR_SYMBOLS) {
        const sl = this.slots.get(s);
        if (sl) await this.evaluateRiskExits(sl);
      }
      if (slot.activeTask) return;

      const refRemaining = this.refRemainingS();
      const buy1Outcome = this.tickStrategy(
        this.buy1State,
        this.buy1,
        (o) => this.buy1SideOk(o),
        refRemaining,
        this.buy1.trigger_time_end_sec,
        this.buy1.trigger_time_start_sec,
      );
      const buy2Outcome = this.tickStrategy(
        this.buy2State,
        this.buy2,
        (o) => this.buy2SideOk(o),
        refRemaining,
        this.buy2.trigger_time_end_sec,
        this.buy2.trigger_time_start_sec,
      );

      if (buy1Outcome && !this.buy1State.done && !this.buy1State.busy) {
        const btcSlot = this.slots.get("btc")!;
        this.buy1State.busy = true;
        btcSlot.activeTask = this.runBuy(btcSlot, buy1Outcome, "BUY1", this.buy1, this.buy1State);
      }
      if (buy2Outcome && !this.buy2State.done && !this.buy2State.busy) {
        const ethSlot = this.slots.get("eth")!;
        this.buy2State.busy = true;
        ethSlot.activeTask = this.runBuy(ethSlot, buy2Outcome, "BUY2", this.buy2, this.buy2State);
      }
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async runBuy(
    slot: MarketSlot,
    outcome: string,
    label: string,
    cfg: Buy1Config | Buy2Config,
    state: EntryStrategyState,
  ): Promise<void> {
    try {
      const price = clampBuyPrice(cfg.buy_limit_price);
      const size = Math.round(cfg.shares * 10000) / 10000;
      const tokenId = outcomeTokenId(slot, outcome);
      const orderType = (cfg.order_type || "FAK").toUpperCase();
      const triggerBid = bestBidForOutcome(slot, outcome);
      const triggerAsk = bestAskForOutcome(slot, outcome);
      log(
        slot.tag,
        `[${label}] trigger buy_outcome=${outcome} bid=${triggerBid.toFixed(4)} ask=${triggerAsk.toFixed(4)} limit_px=${price.toFixed(4)} type=${orderType}`,
        slot,
      );
      jsonl(slot, {
        event: `${label}_TRIGGER`,
        buy_outcome: outcome,
        trigger_bid: triggerBid,
        trigger_ask: triggerAsk,
        buy_limit_price: price,
        order_type: orderType,
        shares: size,
      });

      const [placed, orderErr] = await this.placeLimitBuy(
        slot,
        tokenId,
        price,
        size,
        outcome,
        orderType,
        label,
      );

      if (placed) {
        state.done = true;
        const pos = slot.position;
        pos.outcome = outcome.toUpperCase();
        pos.entryLabel = label;
        pos.orderPrice = price;
        pos.targetShares = size;
        pos.pendingOrder = true;
        pos.baselineRemYes = slot.remYes;
        pos.baselineRemNo = slot.remNo;
        pos.tradesSeen = slot.userStore?.trades.length ?? 0;
        if (slot.refreshBalances) await slot.refreshBalances();
        this.ingestBuyFills(slot);
        log(slot.tag, `[${label}_ORDER] outcome=${outcome} sz=${size.toFixed(4)} awaiting fill`, slot);
        jsonl(slot, {
          event: `${label}_ORDER`,
          buy_outcome: outcome,
          price,
          size,
          order_type: orderType,
        });
      } else if (isFakNoMatchError(orderErr)) {
        log(slot.tag, `[${label}_FAK_NO_MATCH] will retry when conditions hold`, slot);
        jsonl(slot, { event: `${label}_FAK_NO_MATCH`, buy_outcome: outcome, error: orderErr });
      } else {
        state.done = true;
        log(slot.tag, `[${label}_ABORT] reason=order_rejected err=${orderErr}`, slot);
        jsonl(slot, {
          event: `${label}_ABORT`,
          buy_outcome: outcome,
          reason: "order_rejected",
          error: orderErr,
        });
      }
    } finally {
      state.busy = false;
      slot.activeTask = null;
    }
  }

  private async placeLimitBuy(
    slot: MarketSlot,
    tokenId: string,
    price: number,
    shares: number,
    outcome: string,
    orderType: string,
    eventLabel: string,
  ): Promise<[boolean, string]> {
    if (shares <= 0) return [false, "invalid_shares"];
    const size = Math.round(shares * 10000) / 10000;
    if (size <= 0) return [false, "invalid_shares"];
    const label = (eventLabel || "BUY").toUpperCase();
    log(slot.tag, `[${label}] limit BUY px=${price.toFixed(4)} sz=${size.toFixed(4)} type=${orderType}`, slot);

    const bestBid = bestBidForOutcome(slot, outcome);
    const bestAsk = bestAskForOutcome(slot, outcome);

    if (slot.paperAccount) {
      const [ok, meta] = slot.paperAccount.placeLimitOrder(tokenId, "BUY", price, size, {
        bookBid: bestBid > 0 ? bestBid : undefined,
        bookAsk: bestAsk > 0 ? bestAsk : undefined,
        orderType,
      });
      if (ok) return [true, ""];
      return [false, String(meta?.reason ?? "paper_order_rejected")];
    }

    const client = slot.clobClient;
    if (!client) return [false, "no_clob_client"];

    try {
      const negRisk = await client.getNegRisk(tokenId);
      const tickSize = await client.getTickSize(tokenId);
      const signed = await client.createOrder(tokenId, "BUY", price, size, {
        negRisk,
        tickSize,
      });
      const resp = await client.postOrder(signed, orderType);
      if (resp.error) {
        const err = String(resp.error || "order_error");
        log(slot.tag, `[${label}] order error: ${err}`, slot);
        return [false, err];
      }
      return [true, ""];
    } catch (e) {
      const err = String(e).trim() || (e instanceof Error ? e.name : "Error");
      log(slot.tag, `[${label}] order exception: ${err}`, slot);
      return [false, err];
    }
  }

  private async placeLimitSell(
    slot: MarketSlot,
    outcome: string,
    price: number,
    shares: number,
    eventLabel: string,
    attempt: number,
  ): Promise<boolean> {
    if (shares <= this.epsilon) return true;
    const size = Math.round(shares * 10000) / 10000;
    if (size <= 0) return false;
    const tokenId = outcomeTokenId(slot, outcome);
    const label = (eventLabel || "SELL").toUpperCase();
    log(slot.tag, `[${label}] limit SELL px=${price.toFixed(4)} sz=${size.toFixed(4)} attempt=${attempt}`, slot);

    const bestBid = bestBidForOutcome(slot, outcome);
    jsonl(slot, {
      event: `${label}_ORDER`,
      sell_outcome: outcome,
      token_id: tokenId,
      price,
      size,
      attempt,
      best_bid: bestBid,
      rem_yes: slot.remYes,
      rem_no: slot.remNo,
    });

    if (slot.paperAccount) {
      const [ok] = slot.paperAccount.placeLimitOrder(tokenId, "SELL", price, size, {
        bookBid: bestBid > 0 ? bestBid : price,
        orderType: "GTC",
      });
      return ok;
    }

    const client = slot.clobClient;
    if (!client) return false;

    try {
      const negRisk = await client.getNegRisk(tokenId);
      const tickSize = await client.getTickSize(tokenId);
      const signed = await client.createOrder(tokenId, "SELL", price, size, { negRisk, tickSize });
      const resp = await client.postOrder(signed, "GTC");
      return !resp.error;
    } catch {
      return false;
    }
  }
}

export { EntryStrategyCoordinator as MonitorContextCoordinator };
