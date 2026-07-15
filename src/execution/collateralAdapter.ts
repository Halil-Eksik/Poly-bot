/** Resolve CtfCollateralAdapter address for redeem (neg-risk vs standard). */

import { collateralAdapterAddress } from "../constants.js";
import type { ClobClient } from "./clobClient.js";

export async function resolveCollateralAdapter(
  yesTokenId: string,
  clobClient: ClobClient | null | undefined,
  options?: {
    ctfAdapterOverride?: string;
    negRiskAdapterOverride?: string;
  },
): Promise<string> {
  let negRisk = false;
  if (clobClient) {
    try {
      negRisk = Boolean(await clobClient.getNegRisk(yesTokenId));
    } catch {
      negRisk = false;
    }
  }
  const override = negRisk
    ? (options?.negRiskAdapterOverride ?? "")
    : (options?.ctfAdapterOverride ?? "");
  return collateralAdapterAddress({ negRisk, override });
}
