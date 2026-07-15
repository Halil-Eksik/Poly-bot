/** Virtual CLOB fills for paper trading — delayed settlement + partial fills like live. */

import type { BotConfig } from "../config.js";

export interface PaperFill {
  tokenId: string;
  sideLabel: string;
  price: number;
  size: number;
  usdcProceeds: number;
  filledAt: Date;
  bestBidAtFill: number;
  reason?: string | null;
  isBuy?: boolean;
  feeUsdc?: number;
  limitPriceAtDecision?: number | null;
  bestBidAtDecision?: number | null;
}

interface PendingSettlement {
  tokenId: string;
  side: string;
  limitPrice: number;
  shares: number;
  settleAtMono: number;
  yesTokenId: string;
  noTokenId: string;
  bookBid: number | null;
  orderType: string;
  ticksUntilSettle: number | null;
}

function feeOnNotional(notional: number, feeBps: number): number {
  if (notional <= 0 || feeBps <= 0) return 0;
  return Math.round((notional * feeBps) / 10000 * 1e8) / 1e8;
}

export function paperSessionFromBotConfig(bot: BotConfig): PaperSessionLedger {
  return new PaperSessionLedger(bot.paper_starting_usdc, bot.paper_fee_bps, {
    settlementDelayMinS: bot.paper_settlement_delay_min_s,
    settlementDelayMaxS: bot.paper_settlement_delay_max_s,
    partialFillFractionMin: bot.paper_partial_fill_fraction_min,
    partialFillFractionMax: bot.paper_partial_fill_fraction_max,
    fakPartialFillFractionMin: bot.paper_fak_partial_fill_fraction_min,
    fakPartialFillFractionMax: bot.paper_fak_partial_fill_fraction_max,
    sellLimitSettleTicks: bot.paper_sell_limit_settle_ticks,
  });
}

export class PaperSessionLedger {
  readonly startingUsdc: number;
  readonly feeBps: number;
  readonly sellLimitSettleTicks: number;
  usdcCash: number;
  readonly settlementDelayMinS: number;
  readonly settlementDelayMaxS: number;
  readonly partialFillFractionMin: number;
  readonly partialFillFractionMax: number;
  readonly fakPartialFillFractionMin: number;
  readonly fakPartialFillFractionMax: number;
  readonly fills: PaperFill[] = [];
  private readonly positions = new Map<string, [number, number]>();
  private readonly pending: PendingSettlement[] = [];
  private lastMonitorTickMono = 0;

  constructor(
    startingUsdc: number,
    feeBps = 0,
    options?: {
      settlementDelayMinS?: number;
      settlementDelayMaxS?: number;
      partialFillFractionMin?: number;
      partialFillFractionMax?: number;
      fakPartialFillFractionMin?: number | null;
      fakPartialFillFractionMax?: number | null;
      sellLimitSettleTicks?: number;
      randomSeed?: number;
    },
  ) {
    this.startingUsdc = startingUsdc;
    this.feeBps = feeBps;
    this.usdcCash = startingUsdc;
    this.sellLimitSettleTicks = Math.max(1, options?.sellLimitSettleTicks ?? 2);
    this.settlementDelayMinS = Math.max(0, options?.settlementDelayMinS ?? 0.5);
    this.settlementDelayMaxS = Math.max(
      this.settlementDelayMinS,
      options?.settlementDelayMaxS ?? 2.0,
    );
    this.partialFillFractionMin = Math.max(0.01, Math.min(1, options?.partialFillFractionMin ?? 0.5));
    this.partialFillFractionMax = Math.max(
      this.partialFillFractionMin,
      Math.min(1, options?.partialFillFractionMax ?? 1),
    );
    const fakLo = options?.fakPartialFillFractionMin ?? this.partialFillFractionMin;
    const fakHi = options?.fakPartialFillFractionMax ?? this.partialFillFractionMax;
    this.fakPartialFillFractionMin = Math.max(0.01, Math.min(1, fakLo));
    this.fakPartialFillFractionMax = Math.max(
      this.fakPartialFillFractionMin,
      Math.min(1, fakHi),
    );
  }

  private pos(tokenId: string): [number, number] {
    return this.positions.get(tokenId) ?? [0, 0];
  }

  private setPos(tokenId: string, shares: number, costBasis: number): void {
    if (shares <= 1e-12) {
      this.positions.delete(tokenId);
    } else {
      this.positions.set(tokenId, [shares, costBasis]);
    }
  }

  private fillFraction(orderType: string): number {
    const ot = (orderType || "GTC").toUpperCase();
    const [lo, hi] =
      ot === "FAK"
        ? [this.fakPartialFillFractionMin, this.fakPartialFillFractionMax]
        : [this.partialFillFractionMin, this.partialFillFractionMax];
    return lo + Math.random() * (hi - lo);
  }

  private settlementDelayS(): number {
    if (this.settlementDelayMaxS <= this.settlementDelayMinS) {
      return this.settlementDelayMinS;
    }
    return (
      this.settlementDelayMinS +
      Math.random() * (this.settlementDelayMaxS - this.settlementDelayMinS)
    );
  }

  settlePending(nowMono?: number): PaperFill[] {
    const now = nowMono ?? performance.now() / 1000;
    const applied: PaperFill[] = [];
    const still: PendingSettlement[] = [];
    for (const p of this.pending) {
      if (p.ticksUntilSettle != null) {
        still.push(p);
        continue;
      }
      if (p.settleAtMono > now) {
        still.push(p);
        continue;
      }
      const fill = this.applySettlement(p);
      if (fill) applied.push(fill);
    }
    this.pending.length = 0;
    this.pending.push(...still);
    return applied;
  }

  advanceMonitorTick(options?: { pollIntervalS?: number }): PaperFill[] {
    const gap = Math.max(0.02, (options?.pollIntervalS ?? 0.1) * 0.85);
    const now = performance.now() / 1000;
    if (now - this.lastMonitorTickMono < gap) return [];
    this.lastMonitorTickMono = now;

    const applied: PaperFill[] = [];
    const still: PendingSettlement[] = [];
    for (const p of this.pending) {
      if (p.ticksUntilSettle == null) {
        still.push(p);
        continue;
      }
      p.ticksUntilSettle -= 1;
      if (p.ticksUntilSettle > 0) {
        still.push(p);
        continue;
      }
      const fill = this.applySettlement(p);
      if (fill) applied.push(fill);
    }
    this.pending.length = 0;
    this.pending.push(...still);
    return applied;
  }

  private applySettlement(p: PendingSettlement): PaperFill | null {
    const side = p.side.toUpperCase();
    const tid = p.tokenId;
    const px = p.limitPrice;
    let shares = p.shares;
    if (shares <= 1e-9 || px <= 0) return null;

    let sideLabel = "";
    if (tid === p.yesTokenId) sideLabel = "YES";
    else if (tid === p.noTokenId) sideLabel = "NO";
    else return null;

    const refBid = p.bookBid ?? px;
    const notional = px * shares;
    const fee = feeOnNotional(notional, this.feeBps);

    if (side === "BUY") {
      const cost = notional + fee;
      if (this.usdcCash + 1e-9 < cost) return null;
      this.usdcCash -= cost;
      const [sh, cb] = this.pos(tid);
      this.setPos(tid, sh + shares, cb + cost);
      const fill: PaperFill = {
        tokenId: tid,
        sideLabel,
        price: px,
        size: shares,
        usdcProceeds: -Math.round(cost * 1e8) / 1e8,
        filledAt: new Date(),
        bestBidAtFill: refBid,
        reason: `paper_buy_${p.orderType.toLowerCase()}`,
        isBuy: true,
        feeUsdc: Math.round(fee * 1e8) / 1e8,
        limitPriceAtDecision: px,
        bestBidAtDecision: refBid,
      };
      this.fills.push(fill);
      return fill;
    }

    const [bal, cb] = this.pos(tid);
    if (bal + 1e-9 < shares) shares = Math.max(0, bal);
    if (shares <= 1e-9) return null;
    const avgCost = bal > 1e-9 ? cb / bal : 0;
    const costSold = avgCost * shares;
    const gross = px * shares;
    const feeS = feeOnNotional(gross, this.feeBps);
    const net = gross - feeS;
    this.usdcCash += net;
    const newRem = bal - shares;
    if (newRem <= 1e-9) this.setPos(tid, 0, 0);
    else this.setPos(tid, newRem, Math.max(0, cb - costSold));

    const fill: PaperFill = {
      tokenId: tid,
      sideLabel,
      price: px,
      size: shares,
      usdcProceeds: Math.round(net * 1e8) / 1e8,
      filledAt: new Date(),
      bestBidAtFill: refBid,
      reason: `paper_sell_${p.orderType.toLowerCase()}`,
      isBuy: false,
      feeUsdc: Math.round(feeS * 1e8) / 1e8,
      limitPriceAtDecision: px,
      bestBidAtDecision: refBid,
    };
    this.fills.push(fill);
    return fill;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  placeLimitOrder(
    tokenId: string,
    side: string,
    price: number,
    shares: number,
    options: {
      bookBid?: number | null;
      bookAsk?: number | null;
      yesTokenId: string;
      noTokenId: string;
      orderType?: string;
    },
  ): [boolean, Record<string, number> | null] {
    if (!(price > 0 && shares > 0)) return [false, null];
    const u = side.toUpperCase();
    const tid = String(tokenId);
    if (tid !== String(options.yesTokenId) && tid !== String(options.noTokenId)) {
      return [false, null];
    }

    const ot = (options.orderType || "GTC").toUpperCase();
    let ticksUntilSettle: number | null = null;
    let delayS = 0;
    let settleAt = Number.POSITIVE_INFINITY;
    let frac: number;
    if (u === "SELL" && (ot === "GTC" || ot === "GTD")) {
      frac = 1;
      ticksUntilSettle = this.sellLimitSettleTicks;
    } else {
      frac = this.fillFraction(ot);
      delayS = this.settlementDelayS();
      settleAt = performance.now() / 1000 + delayS;
    }
    let fillShares = Math.max(1e-6, shares * frac);

    if (u === "BUY") {
      let est = price * fillShares;
      est += feeOnNotional(est, this.feeBps);
      if (this.usdcCash + 1e-9 < est) return [false, null];
    } else {
      const [bal] = this.pos(tid);
      if (bal + 1e-9 < fillShares) fillShares = Math.max(0, bal);
      if (fillShares <= 1e-9) return [false, null];
    }

    this.pending.push({
      tokenId: tid,
      side: u,
      limitPrice: price,
      shares: fillShares,
      settleAtMono: settleAt,
      yesTokenId: String(options.yesTokenId),
      noTokenId: String(options.noTokenId),
      bookBid: options.bookBid ?? null,
      orderType: ot,
      ticksUntilSettle,
    });

    const meta: Record<string, number> = {
      realized_pnl_usd: 0,
      wallet_balance_usd: Math.round(this.usdcCash * 1e8) / 1e8,
      paper_pending: 1,
      paper_scheduled_shares: Math.round(fillShares * 1e6) / 1e6,
    };
    if (ticksUntilSettle != null) meta.paper_settle_ticks = ticksUntilSettle;
    else meta.paper_settlement_delay_s = Math.round(delayS * 1000) / 1000;
    return [true, meta];
  }

  balancesForPair(yesTokenId: string, noTokenId: string): [number, number] {
    this.settlePending();
    const [y] = this.pos(String(yesTokenId));
    const [n] = this.pos(String(noTokenId));
    return [y, n];
  }
}

export class PaperV2Account {
  readonly yesTokenId: string;
  readonly noTokenId: string;
  private readonly session: PaperSessionLedger;

  constructor(
    yesTokenId: string,
    noTokenId: string,
    options?: {
      session?: PaperSessionLedger;
      startingUsdc?: number;
      feeBps?: number;
      settlementDelayMinS?: number;
      settlementDelayMaxS?: number;
      partialFillFractionMin?: number;
      partialFillFractionMax?: number;
      fakPartialFillFractionMin?: number | null;
      fakPartialFillFractionMax?: number | null;
    },
  ) {
    this.yesTokenId = yesTokenId;
    this.noTokenId = noTokenId;
    this.session =
      options?.session ??
      new PaperSessionLedger(options?.startingUsdc ?? 0, options?.feeBps ?? 0, {
        settlementDelayMinS: options?.settlementDelayMinS,
        settlementDelayMaxS: options?.settlementDelayMaxS,
        partialFillFractionMin: options?.partialFillFractionMin,
        partialFillFractionMax: options?.partialFillFractionMax,
        fakPartialFillFractionMin: options?.fakPartialFillFractionMin,
        fakPartialFillFractionMax: options?.fakPartialFillFractionMax,
      });
  }

  get startingUsdc(): number {
    return this.session.startingUsdc;
  }

  get feeBps(): number {
    return this.session.feeBps;
  }

  balances(): [number, number] {
    return this.session.balancesForPair(this.yesTokenId, this.noTokenId);
  }

  settlePending(): PaperFill[] {
    return this.session.settlePending();
  }

  advanceMonitorTick(options?: { pollIntervalS?: number }): PaperFill[] {
    return this.session.advanceMonitorTick(options);
  }

  pendingCount(): number {
    return this.session.pendingCount();
  }

  placeLimitOrder(
    tokenId: string,
    side: string,
    price: number,
    shares: number,
    options?: {
      bookBid?: number | null;
      bookAsk?: number | null;
      orderType?: string;
    },
  ): [boolean, Record<string, number> | null] {
    return this.session.placeLimitOrder(tokenId, side, price, shares, {
      bookBid: options?.bookBid,
      bookAsk: options?.bookAsk,
      yesTokenId: this.yesTokenId,
      noTokenId: this.noTokenId,
      orderType: options?.orderType,
    });
  }

  toMonitorSummary(): Record<string, unknown> {
    const [ry, rn] = this.balances();
    return {
      paper_usdc_cash: Math.round(this.session.usdcCash * 1e6) / 1e6,
      paper_rem_yes: Math.round(ry * 1e6) / 1e6,
      paper_rem_no: Math.round(rn * 1e6) / 1e6,
      paper_pending_orders: this.session.pendingCount(),
      paper_starting_usdc: Math.round(this.session.startingUsdc * 1e6) / 1e6,
      paper_fills_count: this.session.fills.length,
    };
  }
}
