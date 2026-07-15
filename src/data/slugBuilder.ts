/** Compute current/next epoch slug for 5m (e.g. btc-updown-5m-{unix_ts}). */

import { INTERVAL_SECONDS } from "../constants.js";

export interface EpochSlugs {
  currentSlug: string;
  currentStart: Date;
  nextSlug: string;
  nextStart: Date;
}

export function epochStartTs(
  nowUtc: Date,
  intervalSeconds: number,
  offset = 0,
): number {
  const ts = Math.floor(nowUtc.getTime() / 1000);
  return Math.floor((ts - offset) / intervalSeconds) * intervalSeconds + offset;
}

export function buildStructuredSlug(
  asset: string,
  interval: string,
  epochTs: number,
): string {
  return `${asset}-updown-${interval}-${epochTs}`;
}

export function computeEpochSlugs(
  asset: string,
  interval: string,
  nowUtc?: Date,
): EpochSlugs {
  const now = nowUtc ?? new Date();
  const seconds = INTERVAL_SECONDS[interval] ?? 300;
  const offset = 0;
  const currentTs = epochStartTs(now, seconds, offset);
  const nextTs = currentTs + seconds;
  const currentStart = new Date(currentTs * 1000);
  const nextStart = new Date(nextTs * 1000);
  return {
    currentSlug: buildStructuredSlug(asset.toLowerCase(), interval, currentTs),
    currentStart,
    nextSlug: buildStructuredSlug(asset.toLowerCase(), interval, nextTs),
    nextStart,
  };
}
