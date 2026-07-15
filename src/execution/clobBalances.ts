/** Polymarket CLOB balance-allowance helpers (official SDK flow). */

import {
  AssetType,
  type ClobClient as PolyClobClient,
  type BalanceAllowanceResponse,
} from "@polymarket/clob-client-v2";

const CONDITIONAL_DECIMALS = 1_000_000;

function sharesFromBalanceAllowanceResponse(resp: BalanceAllowanceResponse | null | undefined): number {
  if (!resp) {
    return 0;
  }
  try {
    return Number.parseInt(String(resp.balance ?? 0), 10) / CONDITIONAL_DECIMALS;
  } catch {
    return 0;
  }
}

export async function officialSyncAndGetConditionalPair(
  client: PolyClobClient,
  options: {
    yesTokenId: string;
    noTokenId: string;
    log?: boolean;
    tag?: string;
    syncUpdate?: boolean;
  },
): Promise<[number, number, Record<string, unknown>]> {
  const log = options.log ?? true;
  const syncUpdate = options.syncUpdate ?? true;

  async function one(tokenId: string): Promise<[number, BalanceAllowanceResponse | null]> {
    const params = {
      asset_type: AssetType.CONDITIONAL,
      token_id: String(tokenId),
    };
    if (syncUpdate) {
      try {
        await client.updateBalanceAllowance(params);
      } catch {
        // rate limit / transient
      }
    }
    try {
      const resp = await client.getBalanceAllowance(params);
      return [sharesFromBalanceAllowanceResponse(resp), resp];
    } catch {
      return [0, null];
    }
  }

  const [yesV, yesRaw] = await one(options.yesTokenId);
  const [noV, noRaw] = await one(options.noTokenId);
  const raw = { yes: yesRaw, no: noRaw };

  if (log) {
    const p = options.tag ? `  ${options.tag} ` : "  ";
    console.log(`${p}[BALANCE] CLOB conditional YES=${yesV.toFixed(4)} NO=${noV.toFixed(4)}`);
  }

  return [yesV, noV, raw];
}

export function conditionalBalanceRawFromResponse(resp: unknown): number {
  if (!resp || typeof resp !== "object") {
    return 0;
  }
  const balance = (resp as { balance?: unknown }).balance;
  try {
    return Number.parseInt(String(balance ?? 0), 10);
  } catch {
    return 0;
  }
}
