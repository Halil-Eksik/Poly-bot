/** Polymarket Data API — user positions for conditional balance fallback. */

const DATA_API_URL = "https://data-api.polymarket.com";

export async function fetchOutcomePositionsShares(options: {
  userAddress: string;
  conditionId?: string;
  yesTokenId: string;
  noTokenId: string;
  sizeThreshold?: number;
}): Promise<[number, number] | null> {
  const user = (options.userAddress || "").trim();
  if (!user) {
    return null;
  }

  const yesKey = String(options.yesTokenId).trim();
  const noKey = String(options.noTokenId).trim();
  const params = new URLSearchParams({
    user,
    sizeThreshold: String(Math.max(0, options.sizeThreshold ?? 0)),
    limit: "100",
  });
  const market = (options.conditionId || "").trim();
  if (market) {
    params.set("market", market);
  }

  const url = `${DATA_API_URL.replace(/\/$/, "")}/positions?${params}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      return null;
    }
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) {
      return null;
    }

    let yesSz = 0;
    let noSz = 0;
    for (const row of data) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const rec = row as Record<string, unknown>;
      const asset = String(rec.asset ?? "").trim();
      const size = Number(rec.size ?? 0);
      if (asset === yesKey) {
        yesSz = size;
      } else if (asset === noKey) {
        noSz = size;
      }
    }

    if (yesSz <= 0 && noSz <= 0) {
      return null;
    }
    return [yesSz, noSz];
  } catch {
    return null;
  }
}
