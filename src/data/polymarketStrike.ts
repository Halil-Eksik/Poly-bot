/** Fetch resolution strike ("Price to beat") from Polymarket event page — matches Chainlink stream shown in UI. */

export const POLYMARKET_EVENT_URL = "https://polymarket.com/event";
export const USER_AGENT =
  "Mozilla/5.0 (compatible; polybot5m/1.0; +https://polymarket.com)";

function findPriceToBeat(obj: unknown, targetSlug: string): number | null {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    if (record.slug === targetSlug) {
      const ptb = record.priceToBeat;
      if (typeof ptb === "number" && ptb > 0) {
        return ptb;
      }
      const markets = record.markets;
      if (Array.isArray(markets)) {
        for (const mkt of markets) {
          if (mkt && typeof mkt === "object" && !Array.isArray(mkt)) {
            const m = mkt as Record<string, unknown>;
            if (m.slug === targetSlug) {
              const mPtb = m.priceToBeat;
              if (typeof mPtb === "number" && mPtb > 0) {
                return mPtb;
              }
            }
          }
        }
      }
    }
    for (const v of Object.values(record)) {
      const r = findPriceToBeat(v, targetSlug);
      if (r !== null) {
        return r;
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findPriceToBeat(item, targetSlug);
      if (r !== null) {
        return r;
      }
    }
  }
  return null;
}

/** priceToBeat is often not on the event dict in __NEXT_DATA__; scan JSON after this slug's key. */
function priceToBeatRegexFallback(html: string, targetSlug: string): number | null {
  for (const needle of [`"slug":"${targetSlug}"`, `\\"slug\\":\\"${targetSlug}\\"`]) {
    const idx = html.indexOf(needle);
    if (idx < 0) {
      continue;
    }
    const window = html.slice(idx, idx + 8000);
    const re = /"priceToBeat"\s*:\s*([0-9.]+(?:e[+-]?\d+)?)/g;
    let pm: RegExpExecArray | null;
    while ((pm = re.exec(window)) !== null) {
      try {
        const v = parseFloat(pm[1]!);
        if (v > 1000) {
          return v;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** GET polymarket.com/event/{slug}, parse __NEXT_DATA__ JSON for priceToBeat. */
export async function fetchPriceToBeatFromEventPage(
  slug: string,
  options?: { fetchFn?: typeof fetch },
): Promise<number | null> {
  if (!slug || !slug.trim()) {
    return null;
  }
  const trimmed = slug.trim();
  const url = `${POLYMARKET_EVENT_URL}/${trimmed}`;
  const fetchFn = options?.fetchFn ?? fetch;
  let html: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const resp = await fetchFn(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
      if (resp.status !== 200) {
        console.warn(`Polymarket event page ${trimmed}: HTTP ${resp.status}`);
        return null;
      }
      html = await resp.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(`Polymarket event fetch ${trimmed} failed:`, e);
    return null;
  }

  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (m) {
    try {
      const data: unknown = JSON.parse(m[1]!);
      const p = findPriceToBeat(data, trimmed);
      if (p !== null) {
        return p;
      }
    } catch {
      // ignore
    }
  }

  const p = priceToBeatRegexFallback(html, trimmed);
  if (p !== null) {
    return p;
  }

  console.warn(`Could not parse priceToBeat for slug=${trimmed}`);
  return null;
}
