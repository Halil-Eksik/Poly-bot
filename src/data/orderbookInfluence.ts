/** Top-of-book depth sums and OBI-style influence rate from public CLOB books. */

type BookRow = { price?: unknown; size?: unknown } | Record<string, unknown>;

function bookRows(book: unknown, side: "bids" | "asks"): BookRow[] {
  const key = side;
  if (book && typeof book === "object" && !Array.isArray(book)) {
    const record = book as Record<string, unknown>;
    const rows = record[key];
    return Array.isArray(rows) ? (rows as BookRow[]) : [];
  }
  const rows = (book as Record<string, unknown> | null)?.[key];
  return Array.isArray(rows) ? (rows as BookRow[]) : [];
}

/** price -> total size for bids or asks. */
function aggregateLevels(book: unknown, side: "bids" | "asks"): Map<number, number> {
  const rows = bookRows(book, side);
  const out = new Map<number, number>();
  for (const r of rows) {
    let p: unknown;
    let s: unknown;
    if (r && typeof r === "object") {
      const row = r as Record<string, unknown>;
      p = "price" in row ? row.price : undefined;
      s = "size" in row ? row.size : undefined;
    }
    if (p === undefined || p === null || s === undefined || s === null) {
      continue;
    }
    let pf: number;
    let sf: number;
    try {
      pf = Number(p);
      sf = Number(s);
    } catch {
      continue;
    }
    if (!(pf > 0 && pf <= 1) || sf <= 0) {
      continue;
    }
    out.set(pf, (out.get(pf) ?? 0) + sf);
  }
  return out;
}

export interface InfluenceMetrics {
  bidNSum: number;
  askNSum: number;
  bidLevelsUsed: number;
  askLevelsUsed: number;
  influenceRate: number;
}

/**
 * Sum sizes at the best `top_n` bid price levels and best `top_n` ask price levels (aggregate per price).
 *
 * influence_rate = (bid_n_sum - ask_n_sum) / (bid_n_sum + ask_n_sum + eps) in roughly [-1, 1].
 */
export function influenceFromBook(
  book: unknown | null | undefined,
  options?: { topN?: number; eps?: number },
): InfluenceMetrics {
  const topN = options?.topN ?? 5;
  const eps = options?.eps ?? 1e-9;
  if (!book) {
    return {
      bidNSum: 0,
      askNSum: 0,
      bidLevelsUsed: 0,
      askLevelsUsed: 0,
      influenceRate: 0,
    };
  }
  const bids = aggregateLevels(book, "bids");
  const asks = aggregateLevels(book, "asks");
  const bidPrices = [...bids.keys()].sort((a, b) => b - a).slice(0, topN);
  const askPrices = [...asks.keys()].sort((a, b) => a - b).slice(0, topN);
  const bsum = bidPrices.reduce((acc, p) => acc + (bids.get(p) ?? 0), 0);
  const asum = askPrices.reduce((acc, p) => acc + (asks.get(p) ?? 0), 0);
  const den = bsum + asum + eps;
  const rate = den > eps ? (bsum - asum) / den : 0;
  return {
    bidNSum: Math.round(bsum * 1e8) / 1e8,
    askNSum: Math.round(asum * 1e8) / 1e8,
    bidLevelsUsed: bidPrices.length,
    askLevelsUsed: askPrices.length,
    influenceRate: Math.round(rate * 1e8) / 1e8,
  };
}

export interface PairDepthMetrics {
  yesBid5Sum: number;
  yesAsk5Sum: number;
  yesBid5Levels: number;
  yesAsk5Levels: number;
  yesInfluenceRate: number;
  noBid5Sum: number;
  noAsk5Sum: number;
  noBid5Levels: number;
  noAsk5Levels: number;
  noInfluenceRate: number;
  influenceRate: number;
}

/** Flat dict for JSONL / on_tick: YES book, NO book, and canonical `influence_rate` (= YES book). */
export function pairDepthMetricsForMonitor(
  bookYes: unknown,
  bookNo: unknown,
  options?: { topN?: number },
): PairDepthMetrics {
  const y = influenceFromBook(bookYes, options);
  const n = influenceFromBook(bookNo, options);
  return {
    yesBid5Sum: y.bidNSum,
    yesAsk5Sum: y.askNSum,
    yesBid5Levels: y.bidLevelsUsed,
    yesAsk5Levels: y.askLevelsUsed,
    yesInfluenceRate: y.influenceRate,
    noBid5Sum: n.bidNSum,
    noAsk5Sum: n.askNSum,
    noBid5Levels: n.bidLevelsUsed,
    noAsk5Levels: n.askLevelsUsed,
    noInfluenceRate: n.influenceRate,
    influenceRate: y.influenceRate,
  };
}
