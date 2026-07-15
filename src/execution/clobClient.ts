/** Async wrapper around @polymarket/clob-client-v2 (Polymarket CLOB V2). */

import {
  AssetType,
  BuilderConfig,
  ClobClient as PolyClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type SignedOrder,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { CHAIN_ID, CLOB_API_URL, SIGNATURE_TYPE_POLY_1271 } from "../constants.js";
import { fetchOutcomePositionsShares } from "../data/dataPositions.js";
import { resolveDepositWalletAddress } from "./depositWallet.js";
import {
  conditionalBalanceRawFromResponse,
  officialSyncAndGetConditionalPair,
} from "./clobBalances.js";
import { fetchCtfOutcomeBalancesShares } from "./ctfBalances.js";

const ZERO_BUILDER_CODE = `0x${"0".repeat(64)}` as Hex;
const MIN_CONDITIONAL_BALANCE_POLL_S = 1.0;
const CONDITIONAL_BALANCE_CACHE_MAX_AGE_S = 30.0;
const CONDITIONAL_BALANCE_BACKOFF_BASE_S = 5.0;
const CONDITIONAL_BALANCE_BACKOFF_MAX_S = 60.0;
const CLOB_CONDITIONAL_UPDATE_MIN_S = 45.0;

function orderTypeFromStr(s: string): OrderType {
  const u = (s || "GTC").toUpperCase();
  if (u === "FOK") return OrderType.FOK;
  if (u === "FAK") return OrderType.FAK;
  if (u === "GTD") return OrderType.GTD;
  return OrderType.GTC;
}

export function parseCollateralBalanceAllowanceRaw(resp: unknown): [number, number] {
  if (!resp || typeof resp !== "object") {
    return [0, 0];
  }
  const rec = resp as { balance?: unknown; allowances?: Record<string, unknown> };
  let balance = 0;
  try {
    balance = Number.parseInt(String(rec.balance ?? 0), 10);
  } catch {
    balance = 0;
  }
  let maxAllowance = 0;
  const allowances = rec.allowances;
  if (allowances && typeof allowances === "object") {
    for (const raw of Object.values(allowances)) {
      try {
        maxAllowance = Math.max(maxAllowance, Number.parseInt(String(raw), 10));
      } catch {
        // skip
      }
    }
  }
  return [balance, maxAllowance];
}

export interface ClobClientOptions {
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  host?: string;
  chainId?: number;
  signatureType?: number;
  funder?: string;
  deriveApiCreds?: boolean;
  rpcUrl?: string;
  builderCode?: string;
}

export class ClobClient {
  private readonly _client: PolyClobClient;
  private readonly _signatureType: number;
  private readonly _builderCode: string;
  private readonly _rpcUrl: string;
  private readonly _funderAddress: string;
  private readonly _condBalanceCache = new Map<string, [number, number, number]>();
  private _condBalanceLastAnyMono = 0;
  private _condBalanceBackoffUntil = 0;
  private _condBalanceFailures = 0;
  private _condBalanceRateLimitedAlerted = false;
  private readonly _balanceDebugLogged = new Set<string>();
  private readonly _dataPositionsLogged = new Set<string>();
  private readonly _chainBalanceLogged = new Set<string>();
  private _lastClobConditionalUpdateMono = 0;
  private _condBalanceLock: Promise<void> = Promise.resolve();

  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apiPassphrase: string;

  private constructor(
    client: PolyClobClient,
    fields: {
      signatureType: number;
      builderCode: string;
      rpcUrl: string;
      funderAddress: string;
      apiKey: string;
      apiSecret: string;
      apiPassphrase: string;
    },
  ) {
    this._client = client;
    this._signatureType = fields.signatureType;
    this._builderCode = fields.builderCode;
    this._rpcUrl = fields.rpcUrl;
    this._funderAddress = fields.funderAddress;
    this.apiKey = fields.apiKey;
    this.apiSecret = fields.apiSecret;
    this.apiPassphrase = fields.apiPassphrase;
  }

  /** Factory — derives API creds via createOrDeriveApiKey per Polymarket quickstart. */
  static async create(options: ClobClientOptions): Promise<ClobClient> {
    const privateKey = (options.privateKey || "").trim() as Hex;
    const apiKey = (options.apiKey || "").trim();
    const apiSecret = (options.apiSecret || "").trim();
    const apiPassphrase = (options.apiPassphrase || "").trim();
    const configuredFunder = (options.funder || "").trim();
    const host = (options.host || CLOB_API_URL).replace(/\/$/, "");
    const chainId = options.chainId ?? CHAIN_ID;
    const builderCode = (options.builderCode || "").trim() || ZERO_BUILDER_CODE;
    const deriveApiCreds = options.deriveApiCreds ?? true;
    const hasStatic = Boolean(apiKey && apiSecret && apiPassphrase);

    if (!privateKey && !hasStatic) {
      throw new Error(
        "No CLOB API creds available. Set API_KEY/SECRET/PASSPHRASE or provide PRIVATE_KEY.",
      );
    }

    const depositWallet = privateKey
      ? resolveDepositWalletAddress({ privateKey, chainId, configuredFunder })
      : "";
    const funderAddress = configuredFunder || String(depositWallet || "");

    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const builderConfig: BuilderConfig | undefined =
      builderCode !== ZERO_BUILDER_CODE ? { builderCode } : undefined;

    let creds: ApiKeyCreds | undefined;
    let deriveError: unknown;

    if (deriveApiCreds && privateKey) {
      try {
        const tempClient = new PolyClobClient({ host, chain: chainId, signer });
        creds = await tempClient.createOrDeriveApiKey();
      } catch (e) {
        deriveError = e;
      }
    }

    if (!creds && hasStatic) {
      creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
    } else if (!creds && deriveError) {
      throw new Error(
        `CLOB API credential derivation failed (check PRIVATE_KEY and network). Original error: ${deriveError}`,
      );
    } else if (!creds) {
      throw new Error(
        "No CLOB API creds available and derivation is disabled. Set API_KEY/SECRET/PASSPHRASE or enable derive_clob_api_creds.",
      );
    }

    if (hasStatic && creds.key && apiKey && apiKey !== creds.key) {
      console.warn(
        `WARNING: env API_KEY (${apiKey.slice(0, 12)}...) does not match wallet-derived CLOB key (${creds.key.slice(0, 12)}...). Using derived creds.`,
      );
    }

    const client = new PolyClobClient({
      host,
      chain: chainId,
      signer,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: funderAddress || undefined,
      builderConfig,
    });

    return new ClobClient(client, {
      signatureType: options.signatureType ?? SIGNATURE_TYPE_POLY_1271,
      builderCode,
      rpcUrl: (options.rpcUrl || "").trim(),
      funderAddress,
      apiKey: creds.key || apiKey,
      apiSecret: creds.secret || apiSecret,
      apiPassphrase: creds.passphrase || apiPassphrase,
    });
  }

  walletAddress(): string {
    return this._funderAddress || this._client.funderAddress || "";
  }

  private clobConditionalUpdateAllowed(force = false): boolean {
    if (force) return true;
    return performance.now() / 1000 - this._lastClobConditionalUpdateMono >= CLOB_CONDITIONAL_UPDATE_MIN_S;
  }

  private markClobConditionalUpdate(): void {
    this._lastClobConditionalUpdateMono = performance.now() / 1000;
  }

  private cachedConditionalPair(
    yesTokenId: string,
    noTokenId: string,
    maxAgeS: number,
  ): [number, number] | null {
    const key = `${yesTokenId}:${noTokenId}`;
    const cached = this._condBalanceCache.get(key);
    if (!cached) return null;
    const [yesV, noV, tsMono] = cached;
    if (performance.now() / 1000 - tsMono > maxAgeS) return null;
    return [yesV, noV];
  }

  private storeConditionalPair(yesTokenId: string, noTokenId: string, yesV: number, noV: number): void {
    this._condBalanceCache.set(`${yesTokenId}:${noTokenId}`, [
      yesV,
      noV,
      performance.now() / 1000,
    ]);
  }

  private registerConditionalBalanceFailure(): void {
    this._condBalanceFailures += 1;
    const backoff = Math.min(
      CONDITIONAL_BALANCE_BACKOFF_MAX_S,
      CONDITIONAL_BALANCE_BACKOFF_BASE_S * 2 ** Math.max(0, this._condBalanceFailures - 1),
    );
    this._condBalanceBackoffUntil = performance.now() / 1000 + backoff;
    if (!this._condBalanceRateLimitedAlerted) {
      this._condBalanceRateLimitedAlerted = true;
      console.warn(
        `[BALANCE] CLOB conditional balance read failed or rate-limited; backing off ${backoff.toFixed(0)}s`,
      );
    }
  }

  private async withCondBalanceLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._condBalanceLock;
    let release!: () => void;
    this._condBalanceLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async fetchViaDataApiPositions(
    conditionId: string,
    yesTokenId: string,
    noTokenId: string,
  ): Promise<[number, number] | null> {
    const wallet = this.walletAddress();
    if (!wallet || !(conditionId || "").trim()) return null;
    return fetchOutcomePositionsShares({
      userAddress: wallet,
      conditionId,
      yesTokenId,
      noTokenId,
      sizeThreshold: 0,
    });
  }

  private async fetchConditionalPairViaChain(
    yesTokenId: string,
    noTokenId: string,
    options?: { rpcUrl?: string; walletAddress?: string },
  ): Promise<[number, number] | null> {
    const ru = (options?.rpcUrl ?? this._rpcUrl).trim();
    const wallet = (options?.walletAddress ?? this.walletAddress()).trim();
    if (!ru || !wallet) return null;
    return fetchCtfOutcomeBalancesShares(ru, wallet, yesTokenId, noTokenId);
  }

  private async applyChainBalanceFallback(
    yesTokenId: string,
    noTokenId: string,
    yesV: number,
    noV: number,
    options?: { log?: boolean; tag?: string; rpcUrl?: string; walletAddress?: string },
  ): Promise<[number, number]> {
    if (Math.max(yesV, noV) > 0) return [yesV, noV];
    const chain = await this.fetchConditionalPairViaChain(yesTokenId, noTokenId, options);
    if (!chain) return [yesV, noV];
    const [cy, cn] = chain;
    if (Math.max(cy, cn) <= 0) return [yesV, noV];
    const key = `${yesTokenId}:${noTokenId}`;
    if (!this._chainBalanceLogged.has(key)) {
      this._chainBalanceLogged.add(key);
      const p = options?.tag ? `  ${options.tag} ` : "  ";
      console.log(
        `${p}[BALANCE] CLOB/Data API shares=0; on-chain CTF wallet=${(options?.walletAddress ?? this.walletAddress()).trim()} YES=${cy.toFixed(4)} NO=${cn.toFixed(4)}`,
      );
    }
    return [cy, cn];
  }

  private async fetchConditionalPairViaClobSync(options: {
    yesTokenId: string;
    noTokenId: string;
    conditionId?: string;
    log?: boolean;
    tag?: string;
    rpcUrl?: string;
    walletAddress?: string;
    syncUpdate?: boolean;
    forceClobUpdate?: boolean;
  }): Promise<[number, number]> {
    const doUpdate =
      (options.syncUpdate ?? true) &&
      this.clobConditionalUpdateAllowed(options.forceClobUpdate ?? false);
    const [yesV, noV] = await officialSyncAndGetConditionalPair(this._client, {
      yesTokenId: options.yesTokenId,
      noTokenId: options.noTokenId,
      log: options.log ?? true,
      tag: options.tag,
      syncUpdate: doUpdate,
    });
    if (doUpdate) this.markClobConditionalUpdate();
    if (Math.max(yesV, noV) > 0) return [yesV, noV];

    const dataBal = await this.fetchViaDataApiPositions(
      options.conditionId ?? "",
      options.yesTokenId,
      options.noTokenId,
    );
    if (dataBal && Math.max(dataBal[0], dataBal[1]) > 0) {
      const key = `${options.yesTokenId}:${options.noTokenId}`;
      if (!this._dataPositionsLogged.has(key)) {
        this._dataPositionsLogged.add(key);
        const p = options.tag ? `  ${options.tag} ` : "  ";
        console.log(
          `${p}[BALANCE] CLOB shares=0; Data API /positions user=${this.walletAddress()} YES=${dataBal[0].toFixed(4)} NO=${dataBal[1].toFixed(4)}`,
        );
      }
      return dataBal;
    }

    if (options.log) {
      const key = `${options.yesTokenId}:${options.noTokenId}`;
      if (!this._balanceDebugLogged.has(key)) {
        this._balanceDebugLogged.add(key);
        const p = options.tag ? `  ${options.tag} ` : "  ";
        console.log(
          `${p}[BALANCE] CLOB and Data API both 0 funder=${this.walletAddress()} sig_type=${this._signatureType}`,
        );
      }
    }
    return this.applyChainBalanceFallback(
      options.yesTokenId,
      options.noTokenId,
      yesV,
      noV,
      options,
    );
  }

  async fetchConditionalOutcomeBalancesShares(
    yesTokenId: string,
    noTokenId: string,
    options?: {
      minPollS?: number;
      sync?: boolean;
      conditionId?: string;
      logTag?: string;
      rpcUrl?: string;
      walletAddress?: string;
    },
  ): Promise<[number, number] | null> {
    const ru = (options?.rpcUrl ?? this._rpcUrl).trim();
    const wa = (options?.walletAddress ?? this.walletAddress()).trim();
    const sync = options?.sync ?? false;

    if (!sync && ru && wa) {
      const chainBal = await fetchCtfOutcomeBalancesShares(ru, wa, yesTokenId, noTokenId);
      if (chainBal && Math.max(chainBal[0], chainBal[1]) > 0) {
        this._condBalanceLastAnyMono = performance.now() / 1000;
        this.storeConditionalPair(yesTokenId, noTokenId, chainBal[0], chainBal[1]);
        return chainBal;
      }
    }

    if (sync) {
      try {
        const pair = await this.fetchConditionalPairViaClobSync({
          yesTokenId,
          noTokenId,
          conditionId: options?.conditionId,
          log: Boolean(options?.logTag),
          tag: options?.logTag,
          rpcUrl: options?.rpcUrl,
          walletAddress: options?.walletAddress,
          syncUpdate: true,
          forceClobUpdate: true,
        });
        this._condBalanceFailures = 0;
        this._condBalanceRateLimitedAlerted = false;
        this._condBalanceLastAnyMono = performance.now() / 1000;
        this.storeConditionalPair(yesTokenId, noTokenId, pair[0], pair[1]);
        return pair;
      } catch {
        this.registerConditionalBalanceFailure();
        const cached = this.cachedConditionalPair(
          yesTokenId,
          noTokenId,
          CONDITIONAL_BALANCE_CACHE_MAX_AGE_S,
        );
        if (cached && Math.max(cached[0], cached[1]) > 0) return cached;
        try {
          const pair = await this.applyChainBalanceFallback(
            yesTokenId,
            noTokenId,
            0,
            0,
            {
              log: Boolean(options?.logTag),
              tag: options?.logTag,
              rpcUrl: options?.rpcUrl,
              walletAddress: options?.walletAddress,
            },
          );
          if (Math.max(pair[0], pair[1]) > 0) {
            this.storeConditionalPair(yesTokenId, noTokenId, pair[0], pair[1]);
            return pair;
          }
        } catch {
          return cached;
        }
        return cached;
      }
    }

    const pollIv = Math.max(0.05, options?.minPollS ?? MIN_CONDITIONAL_BALANCE_POLL_S);
    const now = performance.now() / 1000;
    if (now < this._condBalanceBackoffUntil) {
      return this.cachedConditionalPair(yesTokenId, noTokenId, CONDITIONAL_BALANCE_CACHE_MAX_AGE_S);
    }

    return this.withCondBalanceLock(async () => {
      const cached = this.cachedConditionalPair(yesTokenId, noTokenId, pollIv);
      if (cached && performance.now() / 1000 - this._condBalanceLastAnyMono < pollIv) {
        return cached;
      }

      if (ru && wa) {
        const chainBal = await fetchCtfOutcomeBalancesShares(ru, wa, yesTokenId, noTokenId);
        if (chainBal && Math.max(chainBal[0], chainBal[1]) > 0) {
          this._condBalanceLastAnyMono = performance.now() / 1000;
          this.storeConditionalPair(yesTokenId, noTokenId, chainBal[0], chainBal[1]);
          return chainBal;
        }
      }

      try {
        const pair = await this.fetchConditionalPairViaClobSync({
          yesTokenId,
          noTokenId,
          conditionId: options?.conditionId,
          log: false,
          rpcUrl: options?.rpcUrl,
          walletAddress: options?.walletAddress,
          syncUpdate: false,
        });
        this._condBalanceFailures = 0;
        this._condBalanceLastAnyMono = performance.now() / 1000;
        this.storeConditionalPair(yesTokenId, noTokenId, pair[0], pair[1]);
        return pair;
      } catch {
        const stale = this.cachedConditionalPair(
          yesTokenId,
          noTokenId,
          CONDITIONAL_BALANCE_CACHE_MAX_AGE_S,
        );
        this.registerConditionalBalanceFailure();
        if (stale && Math.max(stale[0], stale[1]) > 0) return stale;
        try {
          const pair = await this.applyChainBalanceFallback(
            yesTokenId,
            noTokenId,
            0,
            0,
            { rpcUrl: options?.rpcUrl, walletAddress: options?.walletAddress },
          );
          if (Math.max(pair[0], pair[1]) > 0) {
            this.storeConditionalPair(yesTokenId, noTokenId, pair[0], pair[1]);
            return pair;
          }
        } catch {
          return stale;
        }
        return stale;
      }
    });
  }

  async close(): Promise<void> {
    // no-op
  }

  async getNegRisk(tokenId: string): Promise<boolean> {
    return this._client.getNegRisk(tokenId);
  }

  async getFeeRateBps(tokenId: string): Promise<number> {
    return this._client.getFeeRateBps(tokenId);
  }

  async getTickSize(tokenId: string): Promise<string> {
    return this._client.getTickSize(tokenId);
  }

  async getOrderBook(tokenId: string): Promise<unknown> {
    return this._client.getOrderBook(tokenId);
  }

  async createOrder(
    tokenId: string,
    side: string,
    price: number,
    size: number,
    options?: {
      negRisk?: boolean;
      tickSize?: string | null;
      expiration?: string | null;
      builderCode?: string | null;
    },
  ): Promise<SignedOrder> {
    const expRaw = options?.expiration;
    let expInt = 0;
    if (expRaw != null) {
      const s = String(expRaw).trim();
      if (s !== "" && s !== "0") {
        expInt = Number.parseInt(s, 10);
      }
    }
    const bc = (options?.builderCode || this._builderCode || ZERO_BUILDER_CODE).trim();
    return this._client.createOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL,
        expiration: expInt,
        builderCode: bc,
      },
      {
        tickSize: (options?.tickSize || undefined) as never,
        negRisk: options?.negRisk || undefined,
      },
    );
  }

  async postOrder(signedOrder: SignedOrder, orderType = "FOK"): Promise<Record<string, unknown>> {
    const ot = orderTypeFromStr(orderType);
    return (await this._client.postOrder(signedOrder, ot, false)) as Record<string, unknown>;
  }

  async getConditionalBalanceRaw(tokenId: string, sync = false): Promise<number> {
    const params = { asset_type: AssetType.CONDITIONAL, token_id: String(tokenId) };
    if (sync) {
      try {
        await this._client.updateBalanceAllowance(params);
      } catch {
        // ignore rate limits
      }
    }
    const resp = await this._client.getBalanceAllowance(params);
    return conditionalBalanceRawFromResponse(resp);
  }

  async syncTradingBalances(log = false, tag = ""): Promise<void> {
    if (log) {
      const p = tag ? `  ${tag} ` : "  ";
      console.log(`${p}[BALANCE] CLOB update_balance_allowance COLLATERAL`);
    }
    await this._client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async getCollateralBalanceAllowanceRaw(sync = false): Promise<[number, number]> {
    if (sync) await this.syncTradingBalances();
    const resp = await this._client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return parseCollateralBalanceAllowanceRaw(resp);
  }
}
