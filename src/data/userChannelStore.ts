/** In-memory store for CLOB user-channel trade events (per market). */

function outcomeSide(assetId: string, yesTokenId: string, noTokenId: string): string {
  const aid = String(assetId || "").trim();
  if (aid === String(yesTokenId).trim()) {
    return "YES";
  }
  if (aid === String(noTokenId).trim()) {
    return "NO";
  }
  return "";
}

export class UserChannelStore {
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly maxRecent: number;
  trades: Record<string, unknown>[] = [];
  tradeEvents = 0;
  private balanceRefreshRequested = false;

  constructor(
    conditionId: string,
    yesTokenId: string,
    noTokenId: string,
    maxRecent = 50,
  ) {
    this.conditionId = conditionId;
    this.yesTokenId = yesTokenId;
    this.noTokenId = noTokenId;
    this.maxRecent = maxRecent;
  }

  applyTrade(data: Record<string, unknown>): void {
    this.trades.push({ ...data });
    while (this.trades.length > this.maxRecent) {
      this.trades.shift();
    }
    this.tradeEvents += 1;
    const status = String(data.status ?? "").toUpperCase();
    if (status === "MATCHED" || status === "MINED" || status === "CONFIRMED") {
      this.balanceRefreshRequested = true;
    }
  }

  tradeRowForLog(data: Record<string, unknown>): Record<string, unknown> {
    const assetId = String(data.asset_id ?? "");
    const outcome =
      String(data.outcome ?? "") ||
      outcomeSide(assetId, this.yesTokenId, this.noTokenId);
    return {
      event: "USER_TRADE",
      event_type: "trade",
      trade_id: data.id,
      condition_id: data.market ?? this.conditionId,
      asset_id: assetId,
      outcome,
      side: data.side,
      price: data.price,
      size: data.size,
      status: data.status,
      trader_side: data.trader_side,
      timestamp: data.timestamp,
    };
  }

  consumeBalanceRefresh(): boolean {
    if (!this.balanceRefreshRequested) {
      return false;
    }
    this.balanceRefreshRequested = false;
    return true;
  }

  latestTrade(): Record<string, unknown> | null {
    if (this.trades.length === 0) {
      return null;
    }
    return { ...this.trades[this.trades.length - 1]! };
  }
}
