/** Chainlink Data Streams — REST for strikes (HMAC auth, V3 benchmark decode). */

import { createHash, createHmac } from "node:crypto";
import { CHAINLINK_PRICE_DECIMALS, CHAINLINK_REST_URL } from "../constants.js";

function generateAuthHeaders(
  method: string,
  path: string,
  body: Buffer,
  userId: string,
  secret: string,
): Record<string, string> {
  const ts = String(Math.floor(Date.now()));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sigData = `${method} ${path} ${bodyHash} ${userId} ${ts}`;
  const signature = createHmac("sha256", secret).update(sigData).digest("hex");
  return {
    Authorization: userId,
    "X-Authorization-Timestamp": ts,
    "X-Authorization-Signature-SHA256": signature,
  };
}

function readBigIntFromBytes(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function readSignedBigIntFromBytes(buf: Buffer): bigint {
  const unsigned = readBigIntFromBytes(buf);
  const bitLen = BigInt(buf.length * 8);
  const signBit = 1n << (bitLen - 1n);
  if (unsigned >= signBit) {
    return unsigned - (1n << bitLen);
  }
  return unsigned;
}

function decodeV3BenchmarkPrice(reportHex: string): number | null {
  let raw: Buffer;
  try {
    const hex = reportHex.startsWith("0x") ? reportHex.slice(2) : reportHex;
    raw = Buffer.from(hex, "hex");
  } catch {
    return null;
  }

  if (raw.length < 224) {
    return null;
  }

  try {
    const blobOffset = Number(readBigIntFromBytes(raw.subarray(96, 128)));
    const blobLen = Number(
      readBigIntFromBytes(raw.subarray(blobOffset, blobOffset + 32)),
    );
    const blob = raw.subarray(blobOffset + 32, blobOffset + 32 + blobLen);
    if (blob.length < 224) {
      return null;
    }
    const bpInt = readSignedBigIntFromBytes(blob.subarray(192, 224));
    return Number(bpInt) / CHAINLINK_PRICE_DECIMALS;
  } catch {
    return null;
  }
}

function priceFromReportPayload(data: unknown): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const report = record.report;
  let fullReportHex = "";
  if (report && typeof report === "object" && !Array.isArray(report)) {
    fullReportHex = String((report as Record<string, unknown>).fullReport ?? "");
  }
  if (!fullReportHex && Array.isArray(record.reports) && record.reports.length > 0) {
    const first = record.reports[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      fullReportHex = String((first as Record<string, unknown>).fullReport ?? "");
    }
  }
  if (!fullReportHex) {
    return null;
  }
  const price = decodeV3BenchmarkPrice(fullReportHex);
  if (price !== null && price > 0) {
    return price;
  }
  return null;
}

/** GET a Chainlink report; returns (json body or null, http status). */
async function fetchChainlinkReport(
  path: string,
  userId: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): Promise<[unknown | null, number]> {
  const url = `${CHAINLINK_REST_URL}${path}`;
  const headers = generateAuthHeaders("GET", path, Buffer.alloc(0), userId, secret);
  try {
    const resp = await fetchFn(url, { headers });
    const status = resp.status;
    if (status !== 200) {
      return [null, status];
    }
    return [await resp.json(), status];
  } catch (e) {
    console.warn("Chainlink report fetch failed:", e);
    return [null, 0];
  }
}

/** Latest benchmark price for live spot (use /reports/latest, not timestamp lookup). */
export async function fetchLatestSpotPrice(
  userId: string,
  secret: string,
  feedIdHex: string,
  options?: { fetchFn?: typeof fetch },
): Promise<number | null> {
  if (!feedIdHex || !userId || !secret) {
    return null;
  }
  const path = `/api/v1/reports/latest?feedID=${feedIdHex}`;
  const fetchFn = options?.fetchFn ?? fetch;
  const [data, status] = await fetchChainlinkReport(path, userId, secret, fetchFn);
  if (status !== 200) {
    if (status) {
      console.warn(`Chainlink spot fetch latest: HTTP ${status}`);
    }
    return null;
  }
  return priceFromReportPayload(data);
}

/** Fetch benchmark prices from Chainlink REST at epoch_start_unix. Keys = asset (e.g. btc). */
export async function fetchStrikesAtTimestamp(
  userId: string,
  secret: string,
  feedIds: Record<string, string>,
  epochStartUnix: number,
  options?: { leadDelayS?: number; fetchFn?: typeof fetch },
): Promise<Record<string, number>> {
  if (!feedIds || !userId || !secret) {
    return {};
  }

  const leadDelayS = options?.leadDelayS ?? 1.0;
  if (leadDelayS > 0) {
    await new Promise((resolve) => setTimeout(resolve, leadDelayS * 1000));
  }

  const result: Record<string, number> = {};
  const fetchFn = options?.fetchFn ?? fetch;
  for (const [asset, hexId] of Object.entries(feedIds)) {
    const path = `/api/v1/reports?feedID=${hexId}&timestamp=${epochStartUnix}`;
    try {
      const [data, status] = await fetchChainlinkReport(path, userId, secret, fetchFn);
      if (status !== 200) {
        console.warn(
          `Chainlink strike fetch ${asset} @ ${epochStartUnix}: HTTP ${status}`,
        );
        continue;
      }
      const price = priceFromReportPayload(data);
      if (price !== null) {
        result[asset] = price;
        console.info(`Chainlink strike ${asset}: $${price.toFixed(10)}`);
      }
    } catch (e) {
      console.warn(`Chainlink strike fetch ${asset} failed:`, e);
    }
  }

  return result;
}

/** Abortable stop signal compatible with runChainlinkSpotLoop. */
export interface StopEvent {
  readonly aborted: boolean;
  wait(timeoutMs: number): Promise<boolean>;
}

/** Poll Chainlink reports and mirror spot into price_store[product_id] (e.g. BTC-USD). */
export async function runChainlinkSpotLoop(
  _asset: string,
  feedIdHex: string,
  userId: string,
  secret: string,
  productId: string,
  priceStore: Record<string, number>,
  stopEvent: StopEvent,
  pollIntervalS: number,
  options?: { fetchFn?: typeof fetch },
): Promise<void> {
  const interval = Math.max(0.2, pollIntervalS);
  const fetchFn = options?.fetchFn ?? fetch;
  while (!stopEvent.aborted) {
    const p = await fetchLatestSpotPrice(userId, secret, feedIdHex, { fetchFn });
    if (p !== null && p > 0) {
      priceStore[productId] = p;
    }
    const stopped = await stopEvent.wait(interval * 1000);
    if (stopped) {
      break;
    }
  }
}

/** Helper to build a StopEvent from AbortSignal. */
export function stopEventFromAbort(signal: AbortSignal): StopEvent {
  return {
    get aborted() {
      return signal.aborted;
    },
    wait(timeoutMs: number): Promise<boolean> {
      if (signal.aborted) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve(signal.aborted);
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(true);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
