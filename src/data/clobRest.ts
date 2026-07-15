/** Public CLOB REST API — fetch order book without authentication. */

import { CLOB_API_URL } from "../constants.js";
import type { BookMessage, InMemoryOrderbookStore } from "./orderbook.js";

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export type WsShapeBookMessage = BookMessage & { asset_id: string };

async function fetchWithTimeout(
  url: string,
  timeoutS: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Math.floor(timeoutS * 1000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** REST book in the same shape as CLOB market WebSocket `book` messages. */
export async function fetchBookAsWsShape(
  tokenId: string,
  options?: {
    baseUrl?: string;
    timeoutS?: number;
    signal?: AbortSignal;
  },
): Promise<WsShapeBookMessage> {
  const baseUrl = (options?.baseUrl ?? CLOB_API_URL).replace(/\/$/, "");
  const timeoutS = options?.timeoutS ?? 3.0;
  const url = `${baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
  const resp = await fetchWithTimeout(url, timeoutS, options?.signal);
  if (!resp.ok) {
    throw new Error(`CLOB book fetch error: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return {
    asset_id: tokenId,
    bids: (data.bids as BookMessage["bids"]) ?? [],
    asks: (data.asks as BookMessage["asks"]) ?? [],
  };
}

/** REST poll YES/NO books into an InMemoryOrderbookStore. True if both sides have levels. */
export async function pollBooksIntoStore(
  store: InMemoryOrderbookStore,
  yesTokenId: string,
  noTokenId: string,
  options?: {
    baseUrl?: string;
    timeoutS?: number;
  },
): Promise<boolean> {
  try {
    const [yesMsg, noMsg] = await Promise.all([
      fetchBookAsWsShape(yesTokenId, options),
      fetchBookAsWsShape(noTokenId, options),
    ]);
    store.applyBookMsg(yesMsg);
    store.applyBookMsg(noMsg);
  } catch {
    return false;
  }
  const bookYes = store.bookAsExecutorView(yesTokenId);
  const bookNo = store.bookAsExecutorView(noTokenId);
  const bidsYes = bookYes.bids ?? [];
  const asksYes = bookYes.asks ?? [];
  const bidsNo = bookNo.bids ?? [];
  const asksNo = bookNo.asks ?? [];
  return Boolean(
    (bidsYes.length > 0 || asksYes.length > 0) &&
      (bidsNo.length > 0 || asksNo.length > 0),
  );
}

/** One-shot full books for a token list (optional bootstrap; monitor uses pollBooksIntoStore). */
export async function bootstrapBooks(
  tokenIds: string[],
  options?: { baseUrl?: string },
): Promise<WsShapeBookMessage[]> {
  const out: WsShapeBookMessage[] = [];
  for (const tid of tokenIds) {
    try {
      const msg = await fetchBookAsWsShape(tid, options);
      out.push(msg);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Fetch order book for a token via public REST API.
 * No credentials required.
 *
 * Returns object with .bids and .asks (list of {price, size}).
 * Compatible with executor._best_bid_from_book.
 */
export async function fetchOrderBook(
  tokenId: string,
  baseUrl: string = CLOB_API_URL,
): Promise<OrderBook> {
  const url = `${baseUrl.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CLOB book fetch error: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const bidsRaw = (data.bids as unknown[]) ?? [];
  const asksRaw = (data.asks as unknown[]) ?? [];
  const bids: BookLevel[] = bidsRaw.map((b) => {
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const row = b as Record<string, unknown>;
      return {
        price: Number(row.price ?? 0),
        size: Number(row.size ?? 0),
      };
    }
    return b as BookLevel;
  });
  const asks: BookLevel[] = asksRaw.map((a) => {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const row = a as Record<string, unknown>;
      return {
        price: Number(row.price ?? 0),
        size: Number(row.size ?? 0),
      };
    }
    return a as BookLevel;
  });
  return { bids, asks };
}
