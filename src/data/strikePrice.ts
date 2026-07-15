/** Epoch strike (target) vs spot — used for end-sniper oracle gate (spot from Chainlink per executor). */

import { fetchStrikesAtTimestamp } from "./chainlinkFeed.js";
import { fetchPriceToBeatFromEventPage } from "./polymarketStrike.js";

function assetProductId(asset: string): string {
  return `${asset.toUpperCase()}-USD`;
}

export async function fetchEpochStrike(
  asset: string,
  epochUnix: number,
  priceStore: Record<string, number>,
  provider: string,
  intervalSecs: number,
  chainlinkUserId: string,
  chainlinkSecret: string,
  chainlinkFeedIds: Record<string, string>,
  marketSlug = "",
): Promise<number> {
  void intervalSecs;
  const productId = assetProductId(asset);
  const a = asset.toLowerCase();
  const p = provider.toLowerCase().trim();
  const feedIdsClean = Object.fromEntries(
    Object.entries(chainlinkFeedIds)
      .map(([k, v]) => [k, String(v).trim()])
      .filter(([, v]) => v.length > 0),
  );

  // Chainlink Data Streams (same family as Polymarket resolution)
  if (p === "chainlink" && chainlinkUserId && chainlinkSecret && Object.keys(feedIdsClean).length > 0) {
    const strikes = await fetchStrikesAtTimestamp(
      chainlinkUserId,
      chainlinkSecret,
      feedIdsClean,
      epochUnix,
    );
    if (a in strikes && strikes[a]! > 0) {
      return strikes[a]!;
    }
    console.warn(
      `Chainlink strike empty for ${a} at epoch=${epochUnix} — check feed_ids and API creds; trying fallbacks`,
    );
  }

  if (p === "polymarket" && marketSlug) {
    const pm = await fetchPriceToBeatFromEventPage(marketSlug);
    if (pm !== null && pm > 0) {
      return pm;
    }
  }

  // chainlink requested but polymarket fallback (UI price to beat) when slug present
  if (p === "chainlink" && marketSlug) {
    const pm = await fetchPriceToBeatFromEventPage(marketSlug);
    if (pm !== null && pm > 0) {
      console.info(`Using Polymarket page priceToBeat as strike fallback for ${a}`);
      return pm;
    }
  }

  const fallback = priceStore[productId] ?? 0.0;
  return fallback > 0 ? fallback : 0.0;
}
