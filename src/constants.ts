/** Constants for Polymarket Liquidity Maker Bot. */

export const GAMMA_API_URL = "https://gamma-api.polymarket.com";
export const CLOB_API_URL = "https://clob.polymarket.com";
export const WS_URL = "wss://ws-subscriptions-clob.polymarket.com";
export const WS_MSG_BOOK = "book";
export const WS_MSG_PRICE_CHANGE = "price_change";
export const WS_MSG_ORDER = "order";
export const WS_MSG_TRADE = "trade";
export const WS_USER_PING_INTERVAL_S = 10.0;

export const INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  "5m": 300,
  "15m": 900,
};

export const STRUCTURED_SLUG_INTERVALS: ReadonlySet<string> = new Set(["5m", "15m"]);

// CLOB execution
export const DEFAULT_TICK_SIZE = "0.01";
export const CHAIN_ID = 137; // Polygon mainnet
export const CHAIN_ID_AMOY = 80002; // Polygon Amoy testnet
export const ORDER_TYPE_FOK = "FOK";
export const ORDER_TYPE_GTC = "GTC";

// V2 collateral / CTF (Polygon mainnet)
export const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const CTF_COLLATERAL_ADAPTER_ADDRESS =
  "0xAdA100Db00Ca00073811820692005400218FcE1f";
export const NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS =
  "0xadA2005600Dec949baf300f4C6120000bDB6eAab";
export const LEGACY_CTF_COLLATERAL_ADAPTER_ADDRESS =
  "0xADa100874d00e3331D00F2007a9c336a65009718";
export const LEGACY_NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS =
  "0xAdA200001000ef00D07553cEE7006808F895c6F1";
export const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const PUSD_IMPL_ADDRESS = "0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f";
export const COLLATERAL_ONRAMP_ADDRESS =
  "0x93070a847efEf7F70739046A929D47a521F5B8ee";
export const COLLATERAL_OFFRAMP_ADDRESS =
  "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
export const CTF_EXCHANGE_V2_ADDRESS = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_CTF_EXCHANGE_V2_ADDRESS =
  "0xe2222d279d744050d28e00520010520000310F59";

export const RELAYER_URL = "https://relayer-v2.polymarket.com/";
export const SIGNATURE_TYPE_POLY_1271 = 3;

export const DEPOSIT_WALLET_FACTORIES: Readonly<Record<number, string>> = {
  [CHAIN_ID]: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  [CHAIN_ID_AMOY]: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
};

export const DEPOSIT_WALLET_IMPLEMENTATIONS: Readonly<Record<number, string>> = {
  [CHAIN_ID]: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB",
  [CHAIN_ID_AMOY]: "0x50a88fE9a441cB4c9c2aD6A2207CE2795C7D7Fbd",
};

/** Legacy alias retained for backward compatibility with older imports. */
export const USDCe_ADDRESS = PUSD_ADDRESS;

const LEGACY_COLLATERAL_ADAPTERS = new Set(
  [
    LEGACY_CTF_COLLATERAL_ADAPTER_ADDRESS,
    LEGACY_NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  ].map((a) => a.toLowerCase()),
);

/** True if address is a pre–May 2026 adapter (relayer rejects after cutover). */
export function isLegacyCollateralAdapter(address: string): boolean {
  return LEGACY_COLLATERAL_ADAPTERS.has((address || "").trim().toLowerCase());
}

function adapterOverride(negRisk: boolean, override = ""): string {
  let raw = (override || "").trim();
  if (!raw) {
    const envKey = negRisk
      ? "POLYBOT5MBES_EXECUTION__NEG_RISK_CTF_COLLATERAL_ADAPTER"
      : "POLYBOT5MBES_EXECUTION__CTF_COLLATERAL_ADAPTER";
    raw = (process.env[envKey] || "").trim();
  }
  return raw;
}

/** On-chain target for splitPosition / mergePositions / redeemPositions (V2 adapters). */
export function collateralAdapterAddress(options?: {
  negRisk?: boolean;
  override?: string;
}): string {
  const negRisk = options?.negRisk ?? false;
  const override = options?.override ?? "";
  const custom = adapterOverride(negRisk, override);
  if (custom) {
    if (isLegacyCollateralAdapter(custom)) {
      const current = negRisk
        ? NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS
        : CTF_COLLATERAL_ADAPTER_ADDRESS;
      throw new Error(
        `Legacy collateral adapter ${custom} is no longer accepted by the relayer. ` +
          `Use ${current} (see V2_MIGRATION.md).`,
      );
    }
    return custom;
  }
  if (negRisk) {
    return NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS;
  }
  return CTF_COLLATERAL_ADAPTER_ADDRESS;
}

/** splitPosition / mergePositions target for deposit-wallet relayer batches. */
export function splitTargetForDepositWallet(options?: {
  negRisk?: boolean;
  override?: string;
}): string {
  return collateralAdapterAddress(options);
}

export function mergeTargetForDepositWallet(options?: {
  negRisk?: boolean;
  override?: string;
}): string {
  return splitTargetForDepositWallet(options);
}

export function redeemTargetForDepositWallet(options?: {
  negRisk?: boolean;
  override?: string;
}): string {
  return collateralAdapterAddress(options);
}

// Chainlink Data Streams (strike at epoch; spot poll)
export const CHAINLINK_REST_URL = "https://api.dataengine.chain.link";
export const CHAINLINK_WS_URL = "wss://ws.dataengine.chain.link";
export const CHAINLINK_PRICE_DECIMALS = 1e18;
