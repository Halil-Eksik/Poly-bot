/** Strategy logging helpers for buy/risk JSONL rows. */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Settings } from "./config.js";
import { formatUtcIsoZ } from "./timeUtils.js";

export function utcIsoZ(): string {
  return formatUtcIsoZ(new Date());
}

export function spotMinusStrikeUsd(
  strike: number | null | undefined,
  spot: number | null | undefined,
): number | null {
  if (strike == null || spot == null) {
    return null;
  }
  const st = Number(strike);
  const sp = Number(spot);
  if (!(st > 0 && sp > 0)) {
    return null;
  }
  return sp - st;
}

export function formatSpotMinusStrikeForLog(
  strike: number | null | undefined,
  spot: number | null | undefined,
): string {
  const d = spotMinusStrikeUsd(strike, spot);
  if (d == null) {
    return "";
  }
  const s = d >= 0 ? "+" : "";
  return ` spot_minus_strike=${s}${d.toFixed(6)}`;
}

export function formatAverageSpotMinusForLog(symbol: string, avg: number | null | undefined): string {
  if (avg == null) {
    return "";
  }
  const sym = String(symbol).toLowerCase().trim();
  if (!sym) {
    return "";
  }
  return ` averge_spot_minus_${sym}=${Number(avg).toFixed(5)}`;
}

export function resolveTradingProcessPath(settings: Settings): string | null {
  const raw = (settings.liquidity_maker.trading_process_jsonl || "").trim();
  if (!raw) {
    return null;
  }
  return resolve(raw);
}

export function appendTradingJsonl(path: string | null | undefined, row: Record<string, unknown>): void {
  if (!path || !String(path).trim()) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch (e) {
    console.log(`  trading_process_jsonl write error: ${e}`);
  }
}

export class TradingCycleKey {
  constructor(
    public runCycle: number,
    public symbol: string,
    public epoch: string,
    public slug: string,
    public epochStartUnix: number,
    public epochEndUnix: number,
    public conditionId = "",
    public paperTrading = false,
    public yesTokenId = "",
    public noTokenId = "",
  ) {}

  get cycleId(): string {
    const sym = String(this.symbol).toLowerCase().trim();
    const ep = String(this.epoch).trim();
    return `${sym}/${ep}/${this.epochStartUnix}`;
  }
}

export class TradingCycleJournal {
  private seq = 0;

  constructor(
    public readonly path: string | null,
    public readonly key: TradingCycleKey,
    public readonly tag = "",
  ) {}

  baseFields(compact = false): Record<string, unknown> {
    const k = this.key;
    const base: Record<string, unknown> = {
      run_cycle: k.runCycle,
      symbol: String(k.symbol).toLowerCase().trim(),
      slug: k.slug,
      paper_trading: Boolean(k.paperTrading),
      tag: this.tag,
    };
    if (compact) {
      return base;
    }
    return {
      cycle_id: k.cycleId,
      ...base,
      epoch: String(k.epoch).trim(),
      epoch_start_unix: k.epochStartUnix,
      epoch_end_unix: k.epochEndUnix,
      epoch_start_utc: formatUtcIsoZ(new Date(k.epochStartUnix * 1000)),
      epoch_end_utc: formatUtcIsoZ(new Date(k.epochEndUnix * 1000)),
      condition_id: k.conditionId,
    };
  }

  append(row: Record<string, unknown>, options?: { compact?: boolean }): number {
    if (this.path == null) {
      return 0;
    }
    this.seq += 1;
    const out = {
      ...this.baseFields(options?.compact),
      seq: this.seq,
      ts_utc: utcIsoZ(),
      ...row,
    };
    appendTradingJsonl(this.path, out);
    return this.seq;
  }

  appendStrategy(row: Record<string, unknown>): number {
    return this.append(row, { compact: true });
  }

  logCycleStart(extra: Record<string, unknown> = {}): void {
    this.append({ event: "CYCLE_START", ...extra }, { compact: true });
  }

  logCycleEnd(extra: Record<string, unknown> = {}): void {
    this.append({ event: "CYCLE_END", ...extra }, { compact: true });
  }

  logUserTrade(row: Record<string, unknown>): void {
    this.append(enrichStrategyRowTMinus({ event: "USER_TRADE", ...row }));
  }
}

export function roundTMinusS(remainingS: number | null | undefined): number | null {
  if (remainingS == null) {
    return null;
  }
  const t = Math.max(0, Number(remainingS));
  if (!Number.isFinite(t)) {
    return null;
  }
  return Math.round(t * 1000) / 1000;
}

export function formatTMinusSuffix(remainingS: number | null | undefined): string {
  const t = roundTMinusS(remainingS);
  if (t == null) {
    return "";
  }
  return ` ⏰t_minus=${t.toFixed(3)}s`;
}

export function enrichStrategyRowTMinus(
  row: Record<string, unknown>,
  options?: { remainingS?: number | null },
): Record<string, unknown> {
  const out = { ...row };
  if ("t_minus_s" in out) {
    const t = roundTMinusS(Number(out.t_minus_s));
    if (t != null) {
      out.t_minus_s = t;
    }
    return out;
  }
  let t = roundTMinusS(options?.remainingS);
  if (t == null && "remaining_s" in out) {
    t = roundTMinusS(Number(out.remaining_s));
  }
  if (t != null) {
    out.t_minus_s = t;
  }
  return out;
}

export function strategyPhaseFromEvent(event: string): string {
  const ev = String(event || "").toUpperCase();
  for (const prefix of ["BUY1", "BUY2", "BUY3", "BUY4", "RISK1", "RISK2", "RISK3", "SELL1"]) {
    if (ev === prefix || ev.startsWith(`${prefix}_`)) {
      return prefix.toLowerCase();
    }
  }
  return "";
}

export function buildBtcStrategyFields(fields: {
  spot_minus_strike_btc?: number | null;
  averge_spot_minus_btc?: number | null;
  difference_rate_btc?: number | null;
  max_spot_minus_strike_btc?: number | null;
  min_spot_minus_strike_btc?: number | null;
  btc_yes_best_ask?: number;
  btc_yes_best_bid?: number;
  btc_no_best_ask?: number;
  btc_no_best_bid?: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.spot_minus_strike_btc != null) {
    out.spot_minus_strike_btc = Number(fields.spot_minus_strike_btc.toFixed(6));
  }
  if (fields.averge_spot_minus_btc != null) {
    out.averge_spot_minus_btc = Number(fields.averge_spot_minus_btc.toFixed(5));
  }
  if (fields.difference_rate_btc != null) {
    out.difference_rate_btc = Number(fields.difference_rate_btc.toFixed(2));
  }
  if (fields.max_spot_minus_strike_btc != null) {
    out.max_spot_minus_strike_btc = Number(fields.max_spot_minus_strike_btc.toFixed(4));
  }
  if (fields.min_spot_minus_strike_btc != null) {
    out.min_spot_minus_strike_btc = Number(fields.min_spot_minus_strike_btc.toFixed(4));
  }
  if ((fields.btc_yes_best_ask ?? 0) > 0) {
    out.btc_yes_best_ask = Number((fields.btc_yes_best_ask ?? 0).toFixed(4));
  }
  if ((fields.btc_yes_best_bid ?? 0) > 0) {
    out.btc_yes_best_bid = Number((fields.btc_yes_best_bid ?? 0).toFixed(4));
  }
  if ((fields.btc_no_best_ask ?? 0) > 0) {
    out.btc_no_best_ask = Number((fields.btc_no_best_ask ?? 0).toFixed(4));
  }
  if ((fields.btc_no_best_bid ?? 0) > 0) {
    out.btc_no_best_bid = Number((fields.btc_no_best_bid ?? 0).toFixed(4));
  }
  return out;
}

class SpotMinusStrikeEpochExtrema {
  private min: number | null = null;
  private max: number | null = null;
  private has = false;

  record(sms: number | null): [number | null, number | null] {
    if (sms != null) {
      const v = Number(sms);
      if (!this.has) {
        this.min = v;
        this.max = v;
        this.has = true;
      } else {
        if (v > (this.max ?? v)) {
          this.max = v;
        }
        if (v < (this.min ?? v)) {
          this.min = v;
        }
      }
    }
    return [this.minimum(), this.maximum()];
  }

  minimum(): number | null {
    return this.has ? this.min : null;
  }

  maximum(): number | null {
    return this.has ? this.max : null;
  }
}

export class SpotMinusStrikeEpochAverage {
  private sum = 0;
  private count = 0;

  record(sms: number | null | undefined): number | null {
    if (sms != null) {
      this.sum += Number(sms);
      this.count += 1;
    }
    return this.average();
  }

  average(): number | null {
    if (this.count <= 0) {
      return null;
    }
    return this.sum / this.count;
  }
}

export class BtcStrategySnapshot {
  spotMinusStrikeBtc: number | null = null;
  avergeSpotMinusBtc: number | null = null;
  differenceRateBtc: number | null = null;
  maxSpotMinusStrikeBtc: number | null = null;
  minSpotMinusStrikeBtc: number | null = null;
  yesBestAsk = 0;
  yesBestBid = 0;
  noBestAsk = 0;
  noBestBid = 0;
  private smsExtrema = new SpotMinusStrikeEpochExtrema();

  recordSpotMinusStrikeBtc(sms: number | null): void {
    const [lo, hi] = this.smsExtrema.record(sms);
    this.minSpotMinusStrikeBtc = lo;
    this.maxSpotMinusStrikeBtc = hi;
  }

  resetEpoch(): void {
    this.spotMinusStrikeBtc = null;
    this.avergeSpotMinusBtc = null;
    this.differenceRateBtc = null;
    this.maxSpotMinusStrikeBtc = null;
    this.minSpotMinusStrikeBtc = null;
    this.smsExtrema = new SpotMinusStrikeEpochExtrema();
  }

  asLogFields(): Record<string, unknown> {
    return buildBtcStrategyFields({
      spot_minus_strike_btc: this.spotMinusStrikeBtc,
      averge_spot_minus_btc: this.avergeSpotMinusBtc,
      difference_rate_btc: this.differenceRateBtc,
      max_spot_minus_strike_btc: this.maxSpotMinusStrikeBtc,
      min_spot_minus_strike_btc: this.minSpotMinusStrikeBtc,
      btc_yes_best_ask: this.yesBestAsk,
      btc_yes_best_bid: this.yesBestBid,
      btc_no_best_ask: this.noBestAsk,
      btc_no_best_bid: this.noBestBid,
    });
  }
}

