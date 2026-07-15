/** Configuration — YAML + env (POLYBOT5MBES_ prefix). */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cwd } from 'node:process';

import { config as loadDotenvFile } from 'dotenv';
import { parse as parseYaml } from 'yaml';

import { PUSD_ADDRESS, SIGNATURE_TYPE_POLY_1271 } from './constants.js';

const ENV_PREFIX = 'POLYBOT5MBES_';
const ENV_NESTED_DELIMITER = '__';

export interface ScheduleWindowConfig {
  start_hour: number;
  start_minute: number;
  end_hour: number;
  end_minute: number;
}

/** UTC trading hours. When enabled, bot sleeps outside configured windows. */
export interface ScheduleConfig {
  enabled: boolean;
  weekdays: string[];
  windows: ScheduleWindowConfig[];
  sleep_log_interval_min: number;
}

export interface BotConfig {
  dry_run: boolean;
  paper_trading: boolean;
  paper_starting_usdc: number;
  paper_fee_bps: number;
  paper_settlement_delay_min_s: number;
  paper_settlement_delay_max_s: number;
  paper_partial_fill_fraction_min: number;
  paper_partial_fill_fraction_max: number;
  paper_fak_partial_fill_fraction_min: number | null;
  paper_fak_partial_fill_fraction_max: number | null;
  paper_sell_limit_settle_ticks: number;
  log_level: string;
  log_file: string;
  log_append: boolean;
  log_timestamp_name: boolean;
}

export interface ApiConfig {
  gamma_url: string;
  clob_url: string;
  ws_url: string;
}

export interface Buy1Config {
  enabled: boolean;
  trigger_time_start_sec: number;
  trigger_time_end_sec: number;
  max_spread: number;
  min_best_ask: number;
  spot_minus_strike_btc_abs_min: number;
  averge_spot_minus_btc_abs_min: number;
  spot_minus_strike_eth_abs_min: number;
  other_symbol_min_best_bid: number;
  monitoring_cycles: number;
  shares: number;
  buy_limit_price: number;
  order_type: string;
}

export interface Buy2Config {
  enabled: boolean;
  trigger_time_start_sec: number;
  trigger_time_end_sec: number;
  max_spread: number;
  min_best_ask: number;
  spot_minus_strike_btc_abs_min: number;
  averge_spot_minus_btc_abs_min: number;
  spot_minus_strike_eth_abs_min: number;
  other_symbol_min_best_bid: number;
  monitoring_cycles: number;
  shares: number;
  buy_limit_price: number;
  order_type: string;
}

/** After buy1 fill on BTC: buy opposite leg when fill_px + opposite_best_ask < pair_sum_max. */
export interface Buy3Config {
  enabled: boolean;
  /** Trigger when first-leg fill price + opposite best_ask is below this (default 0.95). */
  pair_sum_max: number;
  /** Limit buy price = opposite best_ask + this offset (default 0.03). */
  opposite_buy_offset: number;
  order_type: string;
}

/** After buy2 fill on ETH: same pair-completion logic as buy3. */
export interface Buy4Config {
  enabled: boolean;
  pair_sum_max: number;
  opposite_buy_offset: number;
  order_type: string;
}

/** Stop loss vs entry price: sell when best_bid < fill_price - loss_offset for N ticks. */
export interface Risk1Config {
  enabled: boolean;
  loss_offset: number;
  monitoring_cycles: number;
  sell_offset: number;
  max_sell_attempts: number;
}

/** Time stop from first confirmed buy fill. */
export interface Risk2Config {
  enabled: boolean;
  hold_timeout_sec: number;
  sell_offset: number;
  max_sell_attempts: number;
}

/** Absolute low bid: sell when best_bid < bid_below for N ticks. */
export interface Risk3Config {
  enabled: boolean;
  bid_below: number;
  monitoring_cycles: number;
  sell_offset: number;
  max_sell_attempts: number;
}

export interface ExecutionConfig {
  balance_epsilon: number;
  enabled: boolean;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  private_key: string;
  funder: string;
  chain_id: number;
  signature_type: number;
  auto_deploy_deposit_wallet: boolean;
  rpc_url: string;
  derive_clob_api_creds: boolean;
  builder_cred_rotation_seconds: number;
  builder_cred_rotation_stagger_markets: boolean;
  collateral_token: string;
  builder_code: string;
  ctf_collateral_adapter: string;
  neg_risk_ctf_collateral_adapter: string;
}

export interface MarketTarget {
  symbol: string;
  epoch: string;
}

export interface ChainlinkConfig {
  streams_user_id: string;
  streams_secret: string;
  feed_ids: Record<string, string>;
}

export interface PriceFeedConfig {
  provider: string;
  chainlink: ChainlinkConfig;
  spot_provider: string;
  chainlink_spot_poll_interval_s: number;
}

/** Strike + spot feeds for optional [STRIKE_SPOT] logging during monitor. */
export interface StrikeSpotContext {
  symbol: string;
  epoch_start_unix: number;
  interval_secs: number;
  strike_provider: string;
  chainlink_user_id: string;
  chainlink_secret: string;
  chainlink_feed_ids: Record<string, string>;
  market_slug: string;
  spot_provider: string;
  chainlink_spot_poll_interval_s: number;
}

/** Monitor order book -> redeem. */
export interface LiquidityMakerConfig {
  redeem_enabled: boolean;
  redeem_async_enabled: boolean;
  redeem_delay_seconds: number;
  redeem_per_symbol_gap_seconds: number;
  redeem_retry_delay_seconds: number;
  redeem_max_retries: number;
  stagger_delay_seconds: number;
  export_dir: string;
  cycles: number;
  monitor_poll_interval_s: number;
  monitor_rest_book_timeout_s: number;
  monitor_balance_refresh_timeout_s: number;
  monitor_balance_force_refresh_min_s: number;
  monitor_wave_collect_timeout_s: number;
  monitor_user_ws_enabled: boolean;
  monitor_balance_poll_interval_s: number;
  monitor_log_interval_s: number;
  monitor_verbose_seconds_before_end: number;
  log_strike_spot_interval_s: number;
  spot_minus_strike_difference_rate_lookback_s: number;
  post_redeem_monitor_seconds: number;
  trading_process_jsonl: string;
  trading_process_log_mode: string;
  trading_process_log_interval_s: number;
  trading_process_log_stdout: boolean;
  opposite_bid_history_enabled: boolean;
  epoch: string;
  symbols: string[];
  markets: MarketTarget[];
}

export interface Settings {
  bot: BotConfig;
  schedule: ScheduleConfig;
  api: ApiConfig;
  execution: ExecutionConfig;
  liquidity_maker: LiquidityMakerConfig;
  price_feed: PriceFeedConfig;
  buy1: Buy1Config;
  buy2: Buy2Config;
  buy3: Buy3Config;
  buy4: Buy4Config;
  risk1: Risk1Config;
  risk2: Risk2Config;
  risk3: Risk3Config;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_SCHEDULE_WINDOWS: ScheduleWindowConfig[] = [
  { start_hour: 4, start_minute: 0, end_hour: 11, end_minute: 0 },
  { start_hour: 18, start_minute: 0, end_hour: 22, end_minute: 0 },
];

const MONITOR_TO_LIQUIDITY_MAKER_KEYS: Record<string, string> = {
  poll_interval_s: 'monitor_poll_interval_s',
  rest_book_timeout_s: 'monitor_rest_book_timeout_s',
  balance_refresh_timeout_s: 'monitor_balance_refresh_timeout_s',
  balance_force_refresh_min_s: 'monitor_balance_force_refresh_min_s',
  balance_poll_interval_s: 'monitor_balance_poll_interval_s',
  wave_collect_timeout_s: 'monitor_wave_collect_timeout_s',
  log_interval_s: 'monitor_log_interval_s',
  verbose_seconds_before_end: 'monitor_verbose_seconds_before_end',
  user_ws_enabled: 'monitor_user_ws_enabled',
};

function defaultBotConfig(): BotConfig {
  return {
    dry_run: true,
    paper_trading: false,
    paper_starting_usdc: 3000.0,
    paper_fee_bps: 0.0,
    paper_settlement_delay_min_s: 0.5,
    paper_settlement_delay_max_s: 2.0,
    paper_partial_fill_fraction_min: 0.5,
    paper_partial_fill_fraction_max: 1.0,
    paper_fak_partial_fill_fraction_min: null,
    paper_fak_partial_fill_fraction_max: null,
    paper_sell_limit_settle_ticks: 2,
    log_level: 'INFO',
    log_file: '',
    log_append: false,
    log_timestamp_name: false,
  };
}

function defaultScheduleConfig(): ScheduleConfig {
  return {
    enabled: false,
    weekdays: [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ],
    windows: [...DEFAULT_SCHEDULE_WINDOWS],
    sleep_log_interval_min: 1,
  };
}

function defaultApiConfig(): ApiConfig {
  return {
    gamma_url: 'https://gamma-api.polymarket.com',
    clob_url: 'https://clob.polymarket.com',
    ws_url: 'wss://ws-subscriptions-clob.polymarket.com',
  };
}

function defaultBuy1Config(): Buy1Config {
  return {
    enabled: true,
    trigger_time_start_sec: 35.0,
    trigger_time_end_sec: 3.0,
    max_spread: 0.07,
    min_best_ask: 0.70,
    spot_minus_strike_btc_abs_min: 40.0,
    averge_spot_minus_btc_abs_min: 18.0,
    spot_minus_strike_eth_abs_min: 1.0,
    other_symbol_min_best_bid: 0.90,
    monitoring_cycles: 2,
    shares: 5.0,
    buy_limit_price: 0.99,
    order_type: 'FAK',
  };
}

function defaultBuy2Config(): Buy2Config {
  return {
    enabled: true,
    trigger_time_start_sec: 36.0,
    trigger_time_end_sec: 4.0,
    max_spread: 0.07,
    min_best_ask: 0.70,
    spot_minus_strike_btc_abs_min: 50.0,
    averge_spot_minus_btc_abs_min: 18.0,
    spot_minus_strike_eth_abs_min: 0.9,
    other_symbol_min_best_bid: 0.90,
    monitoring_cycles: 2,
    shares: 5.0,
    buy_limit_price: 0.99,
    order_type: 'FAK',
  };
}

function defaultBuy3Config(): Buy3Config {
  return {
    enabled: true,
    pair_sum_max: 0.95,
    opposite_buy_offset: 0.03,
    order_type: 'GTC',
  };
}

function defaultBuy4Config(): Buy4Config {
  return {
    enabled: true,
    pair_sum_max: 0.95,
    opposite_buy_offset: 0.03,
    order_type: 'GTC',
  };
}

function defaultRisk1Config(): Risk1Config {
  return {
    enabled: true,
    loss_offset: 0.20,
    monitoring_cycles: 3,
    sell_offset: 0.05,
    max_sell_attempts: 5,
  };
}

function defaultRisk2Config(): Risk2Config {
  return {
    enabled: true,
    hold_timeout_sec: 10.0,
    sell_offset: 0.10,
    max_sell_attempts: 5,
  };
}

function defaultRisk3Config(): Risk3Config {
  return {
    enabled: true,
    bid_below: 0.03,
    monitoring_cycles: 3,
    sell_offset: 0.02,
    max_sell_attempts: 5,
  };
}

function defaultExecutionConfig(): ExecutionConfig {
  return {
    balance_epsilon: 0.01,
    enabled: false,
    api_key: '',
    api_secret: '',
    api_passphrase: '',
    private_key: '',
    funder: '',
    chain_id: 137,
    signature_type: SIGNATURE_TYPE_POLY_1271,
    auto_deploy_deposit_wallet: true,
    rpc_url: 'https://polygon-mainnet.g.alchemy.com/v2/XwoKGTuXJtL-R8bVNwO3N',
    derive_clob_api_creds: true,
    builder_cred_rotation_seconds: 0.0,
    builder_cred_rotation_stagger_markets: false,
    collateral_token: PUSD_ADDRESS,
    builder_code: '',
    ctf_collateral_adapter: '',
    neg_risk_ctf_collateral_adapter: '',
  };
}

function defaultChainlinkConfig(): ChainlinkConfig {
  return {
    streams_user_id: '',
    streams_secret: '',
    feed_ids: {},
  };
}

function defaultPriceFeedConfig(): PriceFeedConfig {
  return {
    provider: 'chainlink',
    chainlink: defaultChainlinkConfig(),
    spot_provider: 'chainlink',
    chainlink_spot_poll_interval_s: 1.0,
  };
}

function defaultLiquidityMakerConfig(): LiquidityMakerConfig {
  return {
    redeem_enabled: true,
    redeem_async_enabled: true,
    redeem_delay_seconds: 120,
    redeem_per_symbol_gap_seconds: 10.0,
    redeem_retry_delay_seconds: 10.0,
    redeem_max_retries: 5,
    stagger_delay_seconds: 5,
    export_dir: 'exports',
    cycles: 0,
    monitor_poll_interval_s: 0.2,
    monitor_rest_book_timeout_s: 3.0,
    monitor_balance_refresh_timeout_s: 3.0,
    monitor_balance_force_refresh_min_s: 1.0,
    monitor_wave_collect_timeout_s: 3.0,
    monitor_user_ws_enabled: true,
    monitor_balance_poll_interval_s: 2.0,
    monitor_log_interval_s: 1.0,
    monitor_verbose_seconds_before_end: 5.0,
    log_strike_spot_interval_s: 0.0,
    spot_minus_strike_difference_rate_lookback_s: 3.0,
    post_redeem_monitor_seconds: 0.0,
    trading_process_jsonl: '',
    trading_process_log_mode: 'trades',
    trading_process_log_interval_s: 0.0,
    trading_process_log_stdout: false,
    opposite_bid_history_enabled: false,
    epoch: '5m',
    symbols: [],
    markets: [],
  };
}

function defaultSettings(): Settings {
  return {
    bot: defaultBotConfig(),
    schedule: defaultScheduleConfig(),
    api: defaultApiConfig(),
    execution: defaultExecutionConfig(),
    liquidity_maker: defaultLiquidityMakerConfig(),
    price_feed: defaultPriceFeedConfig(),
    buy1: defaultBuy1Config(),
    buy2: defaultBuy2Config(),
    buy3: defaultBuy3Config(),
    buy4: defaultBuy4Config(),
    risk1: defaultRisk1Config(),
    risk2: defaultRisk2Config(),
    risk3: defaultRisk3Config(),
  };
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T extends JsonRecord>(base: T, patch: JsonRecord): T {
  const out: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function mapMonitorSection(monitor: JsonRecord): JsonRecord {
  const mapped: JsonRecord = {};
  for (const [key, value] of Object.entries(monitor)) {
    const targetKey = MONITOR_TO_LIQUIDITY_MAKER_KEYS[key] ?? key;
    mapped[targetKey] = value;
  }
  return mapped;
}

/**
 * Normalize legacy/default.yaml layout:
 * - `monitor` -> `liquidity_maker` (with monitor_* field renames)
 * - top-level `epoch` / `symbols` -> `liquidity_maker`
 * - `risk.stop_loss` / `time_stop` / `dead_market` -> `risk1` / `risk2` / `risk3`
 */
export function normalizeYamlConfig(raw: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...raw };

  if (isPlainObject(out.monitor)) {
    const existingLm = isPlainObject(out.liquidity_maker) ? out.liquidity_maker : {};
    out.liquidity_maker = deepMerge(existingLm, mapMonitorSection(out.monitor));
    delete out.monitor;
  }

  if (out.epoch !== undefined) {
    const existingLm = isPlainObject(out.liquidity_maker) ? out.liquidity_maker : {};
    out.liquidity_maker = deepMerge(existingLm, { epoch: out.epoch });
    delete out.epoch;
  }

  if (out.symbols !== undefined) {
    const existingLm = isPlainObject(out.liquidity_maker) ? out.liquidity_maker : {};
    out.liquidity_maker = deepMerge(existingLm, { symbols: out.symbols });
    delete out.symbols;
  }

  if (isPlainObject(out.risk)) {
    const risk = out.risk;
    if (isPlainObject(risk.stop_loss)) {
      const existing = isPlainObject(out.risk1) ? out.risk1 : {};
      out.risk1 = deepMerge(existing, risk.stop_loss);
    }
    if (isPlainObject(risk.time_stop)) {
      const existing = isPlainObject(out.risk2) ? out.risk2 : {};
      out.risk2 = deepMerge(existing, risk.time_stop);
    }
    if (isPlainObject(risk.dead_market)) {
      const existing = isPlainObject(out.risk3) ? out.risk3 : {};
      out.risk3 = deepMerge(existing, risk.dead_market);
    }
    delete out.risk;
  }

  return out;
}

function envPathToSegments(envKey: string): string[] {
  return envKey
    .slice(ENV_PREFIX.length)
    .split(ENV_NESTED_DELIMITER)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function parseEnvScalar(raw: string): unknown {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  if (lower === 'null' || lower === 'none') {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function setNestedValue(target: JsonRecord, path: string[], value: unknown): void {
  if (path.length === 0) {
    return;
  }
  let cursor: JsonRecord = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;
    const next = cursor[segment];
    if (!isPlainObject(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonRecord;
  }
  cursor[path[path.length - 1]!] = value;
}

function applyEnvOverrides(data: JsonRecord): void {
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || rawValue === undefined) {
      continue;
    }
    const path = envPathToSegments(key);
    if (path.length === 0) {
      continue;
    }
    setNestedValue(data, path, parseEnvScalar(rawValue));
  }
}

function coerceScheduleWindow(raw: unknown): ScheduleWindowConfig {
  const src = isPlainObject(raw) ? raw : {};
  return {
    start_hour: Number(src.start_hour ?? 4),
    start_minute: Number(src.start_minute ?? 0),
    end_hour: Number(src.end_hour ?? 11),
    end_minute: Number(src.end_minute ?? 0),
  };
}

function finalizeScheduleConfig(raw: unknown): ScheduleConfig {
  const defaults = defaultScheduleConfig();
  const src = isPlainObject(raw) ? raw : {};
  const windowsRaw = src.windows;
  const windows = Array.isArray(windowsRaw)
    ? windowsRaw.map(coerceScheduleWindow)
    : [];
  return {
    enabled: Boolean(src.enabled ?? defaults.enabled),
    weekdays: Array.isArray(src.weekdays)
      ? src.weekdays.map((day) => String(day).toLowerCase().trim()).filter(Boolean)
      : defaults.weekdays,
    windows: windows.length > 0 ? windows : [...DEFAULT_SCHEDULE_WINDOWS],
    sleep_log_interval_min: Number(src.sleep_log_interval_min ?? defaults.sleep_log_interval_min),
  };
}

function symbolsToMarkets(symbols: unknown, epoch: string): MarketTarget[] {
  if (!Array.isArray(symbols)) {
    return [];
  }
  return symbols
    .map((symbol) => String(symbol).trim().toLowerCase())
    .filter(Boolean)
    .map((symbol) => ({ symbol, epoch }));
}

function coerceMarketTarget(raw: unknown): MarketTarget | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const symbol = String(raw.symbol ?? '').trim().toLowerCase();
  const epoch = String(raw.epoch ?? '5m').trim();
  if (!symbol) {
    return null;
  }
  return { symbol, epoch };
}

function finalizeLiquidityMakerConfig(raw: unknown): LiquidityMakerConfig {
  const defaults = defaultLiquidityMakerConfig();
  const src = isPlainObject(raw) ? raw : {};
  const epoch = String(src.epoch ?? defaults.epoch).trim() || defaults.epoch;
  const symbols = Array.isArray(src.symbols)
    ? src.symbols.map((symbol) => String(symbol).trim().toLowerCase()).filter(Boolean)
    : defaults.symbols;

  let markets: MarketTarget[] = [];
  if (Array.isArray(src.markets)) {
    markets = src.markets
      .map(coerceMarketTarget)
      .filter((market): market is MarketTarget => market !== null);
  }
  if (symbols.length > 0) {
    markets = symbolsToMarkets(symbols, epoch);
  }

  return {
    ...defaults,
    ...(src as Partial<LiquidityMakerConfig>),
    epoch,
    symbols,
    markets,
    redeem_enabled: Boolean(src.redeem_enabled ?? defaults.redeem_enabled),
    redeem_async_enabled: Boolean(src.redeem_async_enabled ?? defaults.redeem_async_enabled),
    redeem_delay_seconds: Number(src.redeem_delay_seconds ?? defaults.redeem_delay_seconds),
    redeem_per_symbol_gap_seconds: Number(
      src.redeem_per_symbol_gap_seconds ?? defaults.redeem_per_symbol_gap_seconds,
    ),
    redeem_retry_delay_seconds: Number(
      src.redeem_retry_delay_seconds ?? defaults.redeem_retry_delay_seconds,
    ),
    redeem_max_retries: Number(src.redeem_max_retries ?? defaults.redeem_max_retries),
    stagger_delay_seconds: Number(src.stagger_delay_seconds ?? defaults.stagger_delay_seconds),
    export_dir: String(src.export_dir ?? defaults.export_dir),
    cycles: Number(src.cycles ?? defaults.cycles),
    monitor_poll_interval_s: Number(
      src.monitor_poll_interval_s ?? defaults.monitor_poll_interval_s,
    ),
    monitor_rest_book_timeout_s: Number(
      src.monitor_rest_book_timeout_s ?? defaults.monitor_rest_book_timeout_s,
    ),
    monitor_balance_refresh_timeout_s: Number(
      src.monitor_balance_refresh_timeout_s ?? defaults.monitor_balance_refresh_timeout_s,
    ),
    monitor_balance_force_refresh_min_s: Number(
      src.monitor_balance_force_refresh_min_s ?? defaults.monitor_balance_force_refresh_min_s,
    ),
    monitor_wave_collect_timeout_s: Number(
      src.monitor_wave_collect_timeout_s ?? defaults.monitor_wave_collect_timeout_s,
    ),
    monitor_user_ws_enabled: Boolean(
      src.monitor_user_ws_enabled ?? defaults.monitor_user_ws_enabled,
    ),
    monitor_balance_poll_interval_s: Number(
      src.monitor_balance_poll_interval_s ?? defaults.monitor_balance_poll_interval_s,
    ),
    monitor_log_interval_s: Number(src.monitor_log_interval_s ?? defaults.monitor_log_interval_s),
    monitor_verbose_seconds_before_end: Number(
      src.monitor_verbose_seconds_before_end ?? defaults.monitor_verbose_seconds_before_end,
    ),
    log_strike_spot_interval_s: Number(
      src.log_strike_spot_interval_s ?? defaults.log_strike_spot_interval_s,
    ),
    spot_minus_strike_difference_rate_lookback_s: Number(
      src.spot_minus_strike_difference_rate_lookback_s ??
        defaults.spot_minus_strike_difference_rate_lookback_s,
    ),
    post_redeem_monitor_seconds: Number(
      src.post_redeem_monitor_seconds ?? defaults.post_redeem_monitor_seconds,
    ),
    trading_process_jsonl: String(src.trading_process_jsonl ?? defaults.trading_process_jsonl),
    trading_process_log_mode: String(
      src.trading_process_log_mode ?? defaults.trading_process_log_mode,
    ),
    trading_process_log_interval_s: Number(
      src.trading_process_log_interval_s ?? defaults.trading_process_log_interval_s,
    ),
    trading_process_log_stdout: Boolean(
      src.trading_process_log_stdout ?? defaults.trading_process_log_stdout,
    ),
    opposite_bid_history_enabled: Boolean(
      src.opposite_bid_history_enabled ?? defaults.opposite_bid_history_enabled,
    ),
  };
}

function finalizePriceFeedConfig(raw: unknown): PriceFeedConfig {
  const defaults = defaultPriceFeedConfig();
  const src = isPlainObject(raw) ? raw : {};
  const chainlinkSrc = isPlainObject(src.chainlink) ? src.chainlink : {};
  const feedIdsSrc = isPlainObject(chainlinkSrc.feed_ids) ? chainlinkSrc.feed_ids : {};
  const feed_ids: Record<string, string> = {};
  for (const [symbol, feedId] of Object.entries(feedIdsSrc)) {
    feed_ids[String(symbol).toLowerCase()] = String(feedId);
  }

  return {
    provider: String(src.provider ?? defaults.provider),
    spot_provider: String(src.spot_provider ?? defaults.spot_provider),
    chainlink_spot_poll_interval_s: Number(
      src.chainlink_spot_poll_interval_s ?? defaults.chainlink_spot_poll_interval_s,
    ),
    chainlink: {
      streams_user_id: String(chainlinkSrc.streams_user_id ?? defaults.chainlink.streams_user_id),
      streams_secret: String(chainlinkSrc.streams_secret ?? defaults.chainlink.streams_secret),
      feed_ids,
    },
  };
}

function mergeSection<T extends object>(defaults: T, raw: unknown): T {
  if (!isPlainObject(raw)) {
    return { ...defaults };
  }
  return deepMerge({ ...defaults } as JsonRecord, raw) as T;
}

function buildSettings(data: JsonRecord): Settings {
  const defaults = defaultSettings();
  return {
    bot: mergeSection(defaults.bot, data.bot),
    schedule: finalizeScheduleConfig(data.schedule),
    api: mergeSection(defaults.api, data.api),
    execution: mergeSection(defaults.execution, data.execution),
    liquidity_maker: finalizeLiquidityMakerConfig(data.liquidity_maker),
    price_feed: finalizePriceFeedConfig(data.price_feed),
    buy1: mergeSection(defaults.buy1, data.buy1),
    buy2: mergeSection(defaults.buy2, data.buy2),
    buy3: mergeSection(defaults.buy3, data.buy3),
    buy4: mergeSection(defaults.buy4, data.buy4),
    risk1: mergeSection(defaults.risk1, data.risk1),
    risk2: mergeSection(defaults.risk2, data.risk2),
    risk3: mergeSection(defaults.risk3, data.risk3),
  };
}

function loadDotenvForConfig(configPath: string): void {
  const resolved = resolve(configPath);
  const searchBases = [dirname(dirname(resolved)), dirname(resolved), cwd()];
  for (const base of searchBases) {
    const envFile = resolve(base, '.env');
    if (existsSync(envFile)) {
      loadDotenvFile({ path: envFile, override: true });
      break;
    }
  }
  loadDotenvFile({ override: true });
}

export function loadConfig(path = 'config/default.yaml'): Settings {
  const configPath = resolve(path);
  loadDotenvForConfig(configPath);

  let yamlData: JsonRecord = {};
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    const parsed = parseYaml(text);
    yamlData = isPlainObject(parsed) ? parsed : {};
  }

  const normalized = normalizeYamlConfig(yamlData);
  const merged = deepMerge(defaultSettings() as unknown as JsonRecord, normalized);
  applyEnvOverrides(merged);
  return buildSettings(merged);
}
