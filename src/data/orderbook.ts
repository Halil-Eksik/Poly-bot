/** In-memory orderbook — apply WSS book snapshots, expose best bid/ask. */

export class BestBidAsk {
  readonly spread: number;
  readonly midpoint: number;

  constructor(
    public readonly bidPrice: number,
    public readonly bidSize: number,
    public readonly askPrice: number,
    public readonly askSize: number,
  ) {
    this.spread = Math.round((askPrice - bidPrice) * 1e6) / 1e6;
    this.midpoint = Math.round(((bidPrice + askPrice) / 2) * 1e6) / 1e6;
  }
}

export interface ExecutorBookView {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

export interface BookMessage {
  asset_id?: string;
  bids?: Array<{ price?: string | number; size?: string | number } | Record<string, unknown>>;
  asks?: Array<{ price?: string | number; size?: string | number } | Record<string, unknown>>;
}

/** Minimal orderbook: snapshot-only updates, best bid/ask lookup. */
export class InMemoryOrderbookStore {
  private readonly _bids = new Map<string, Array<[number, number]>>();
  private readonly _asks = new Map<string, Array<[number, number]>>();

  applyBookMsg(data: BookMessage): void {
    const assetId = String(data.asset_id ?? "");
    if (!assetId) {
      return;
    }
    const bids = (data.bids ?? []).map((b) => {
      const row = b as Record<string, unknown>;
      return [Number(row.price), Number(row.size)] as [number, number];
    });
    const asks = (data.asks ?? []).map((a) => {
      const row = a as Record<string, unknown>;
      return [Number(row.price), Number(row.size)] as [number, number];
    });
    this._bids.set(
      assetId,
      [...bids].sort((a, b) => b[0] - a[0]),
    );
    this._asks.set(
      assetId,
      [...asks].sort((a, b) => a[0] - b[0]),
    );
  }

  /** Snapshot as object with `.bids`/`.asks` list[dict] for executor / influence helpers. */
  bookAsExecutorView(assetId: string): ExecutorBookView {
    const bidsRaw = this._bids.get(assetId) ?? [];
    const asksRaw = this._asks.get(assetId) ?? [];
    const bids = bidsRaw.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
    const asks = asksRaw.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
    return { bids, asks };
  }

  getBestBid(assetId: string): [number, number] | null {
    const bids = this._bids.get(assetId) ?? [];
    return bids[0] ?? null;
  }

  getBestAsk(assetId: string): [number, number] | null {
    const asks = this._asks.get(assetId) ?? [];
    return asks[0] ?? null;
  }

  getBestBidAsk(assetId: string): BestBidAsk | null {
    const bid = this.getBestBid(assetId);
    const ask = this.getBestAsk(assetId);
    if (bid === null || ask === null) {
      return null;
    }
    return new BestBidAsk(bid[0], bid[1], ask[0], ask[1]);
  }

  getAllAssetIds(): string[] {
    const ids = new Set<string>([...this._bids.keys(), ...this._asks.keys()]);
    return [...ids];
  }
}
