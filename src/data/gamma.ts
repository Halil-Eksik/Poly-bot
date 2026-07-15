/** Gamma API client — fetch BTC 5m event by slug. */

import { STRUCTURED_SLUG_INTERVALS } from "../constants.js";
import {
  type CryptoMarketMeta,
  Event,
  type Market,
} from "./models.js";

function parseJsonStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x));
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x));
      }
    } catch {
      // ignore
    }
  }
  return [];
}

/** Parse btc-updown-5m-1707836100 style slug. */
function parseSlugStructured(slug: string): CryptoMarketMeta {
  const parts = slug.split("-");
  if (parts.length < 4 || !/^\d+$/.test(parts[parts.length - 1]!)) {
    throw new Error(`Invalid structured slug: ${slug}`);
  }
  const asset = parts[0]!.toLowerCase();
  let interval = "";
  for (const c of [parts[2], parts[parts.length - 2]!]) {
    if (c && STRUCTURED_SLUG_INTERVALS.has(c)) {
      interval = c;
      break;
    }
  }
  if (!interval) {
    throw new Error(`Unknown interval in slug: ${slug}`);
  }
  const expiry = new Date(parseInt(parts[parts.length - 1]!, 10) * 1000);
  return { asset, interval, slug, expiry };
}

function copyMeta(meta: CryptoMarketMeta, update?: Partial<CryptoMarketMeta>): CryptoMarketMeta {
  return { ...meta, ...update };
}

function classifyEvent(eventData: Record<string, unknown>): Event | null {
  const slug = String(eventData.slug ?? "");
  let marketsRaw = eventData.markets;
  if (!Array.isArray(marketsRaw) || marketsRaw.length === 0) {
    marketsRaw = [eventData];
  }
  let eventMeta: CryptoMarketMeta;
  try {
    eventMeta = parseSlugStructured(slug);
  } catch {
    return null;
  }
  const markets: Market[] = [];
  for (const raw of marketsRaw as Record<string, unknown>[]) {
    const m = raw;
    const clobIds = parseJsonStringList(m.clobTokenIds ?? m.asset_ids ?? []);
    const outcomes = parseJsonStringList(m.outcomes ?? []);
    const question = String(m.question ?? "");
    const marketSlug = String(m.slug ?? slug);
    let meta: CryptoMarketMeta;
    try {
      meta = parseSlugStructured(marketSlug);
    } catch {
      meta = copyMeta(eventMeta);
    }
    const endDateStr = String(m.endDate ?? "");
    if (endDateStr) {
      try {
        const iso = endDateStr.replace("Z", "+00:00");
        meta = copyMeta(meta, { expiry: new Date(iso) });
      } catch {
        // ignore
      }
    }
    markets.push({
      conditionId: String(m.conditionId ?? m.condition_id ?? ""),
      assetIds: clobIds,
      question,
      outcomes,
      meta,
    });
  }
  return new Event(
    String(eventData.id ?? eventData.conditionId ?? ""),
    slug,
    String(eventData.title ?? ""),
    markets,
  );
}

export type FetchFn = typeof fetch;

export class GammaClient {
  private readonly _baseUrl: string;
  private readonly _fetch: FetchFn;

  constructor(baseUrl: string, fetchFn: FetchFn = fetch) {
    this._baseUrl = baseUrl.replace(/\/$/, "");
    this._fetch = fetchFn;
  }

  async fetchEventBySlug(slug: string): Promise<Event> {
    const url = new URL(`${this._baseUrl}/events`);
    url.searchParams.set("slug", slug);
    const resp = await this._fetch(url);
    if (!resp.ok) {
      throw new Error(`Gamma API error: HTTP ${resp.status}`);
    }
    const data: unknown = await resp.json();
    let event: Event | null = null;
    if (Array.isArray(data) && data.length > 0) {
      event = classifyEvent(data[0] as Record<string, unknown>);
    } else if (data && typeof data === "object" && !Array.isArray(data)) {
      event = classifyEvent(data as Record<string, unknown>);
    }
    if (event === null) {
      throw new Error(`No event found for slug: ${slug}`);
    }
    return event;
  }
}
