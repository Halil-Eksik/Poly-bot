/** Models for Gamma events and markets. */

export interface CryptoMarketMeta {
  asset: string;
  interval: string;
  slug: string;
  expiry: Date;
}

export interface Market {
  conditionId: string;
  assetIds: string[];
  question: string;
  outcomes: string[];
  meta: CryptoMarketMeta;
}

/**
 * Map Gamma clobTokenIds to (up_or_yes_id, down_or_no_id) using outcomes labels.
 * Defaults to asset_ids order when outcomes are missing or ambiguous.
 */
export function resolveOutcomeTokenIds(market: Market): [string, string] {
  const ids = (market.assetIds || [])
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
  if (ids.length < 2) {
    throw new Error(`market needs 2 asset ids, got ${ids.length}`);
  }
  const outcomes = (market.outcomes || []).map((o) => String(o).trim().toLowerCase());
  const upWords = new Set(["up", "yes", "y"]);
  const downWords = new Set(["down", "no", "n"]);
  let upI = 0;
  let downI = 1;
  if (outcomes.length >= 2) {
    const o0 = outcomes[0]!;
    const o1 = outcomes[1]!;
    if (downWords.has(o0) && upWords.has(o1)) {
      upI = 1;
      downI = 0;
    } else if (upWords.has(o0) && downWords.has(o1)) {
      upI = 0;
      downI = 1;
    } else if (upWords.has(o1) && !upWords.has(o0)) {
      upI = 1;
      downI = 0;
    }
  }
  return [ids[upI]!, ids[downI]!];
}

export class Event {
  constructor(
    public readonly id: string,
    public readonly slug: string,
    public readonly title: string,
    public readonly markets: Market[],
  ) {}

  allAssetIds(): string[] {
    const out: string[] = [];
    for (const m of this.markets) {
      out.push(...m.assetIds);
    }
    return out;
  }

  /** Return the condition_id of the market that contains this asset_id. */
  conditionIdForAsset(assetId: string): string | null {
    for (const m of this.markets) {
      if (m.assetIds.includes(assetId)) {
        return m.conditionId;
      }
    }
    return null;
  }
}
