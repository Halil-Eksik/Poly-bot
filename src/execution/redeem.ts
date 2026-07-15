/** Redeem winning conditional tokens via CtfCollateralAdapter after market resolution. */

import { encodeFunctionData, getAddress, type Hex } from "viem";

import {
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  PUSD_ADDRESS,
  RELAYER_URL,
  redeemTargetForDepositWallet,
} from "../constants.js";
import {
  DepositWalletRelayer,
  type DepositWalletCall,
  resolveDepositWalletAddress,
} from "./depositWallet.js";

const HASH_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const BUILDER_ENV_PREFIX = "POLYBOT5MBES_EXECUTION__BUILDER_API_";

const REDEEM_ABI = [
  {
    name: "redeemPositions",
    type: "function",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

export function isRateLimitError(err: string): boolean {
  const s = (err || "").toLowerCase();
  return ["rate limit", "rate limit exceeded", "429", "too many requests", "quota exceeded", "throttl"].some(
    (x) => s.includes(x),
  );
}

export function isWalletBusyError(err: string | null | undefined): boolean {
  const s = (err || "").toLowerCase();
  return ["in-flight", "in flight", "wallet busy", "active action"].some((x) => s.includes(x));
}

export function loadBuilderCredsPool(): Array<[string, string, string]> {
  const pool: Array<[string, string, string]> = [];
  for (let i = 1; i < 20; i += 1) {
    const key = process.env[`${BUILDER_ENV_PREFIX}KEY_${i}`] || "";
    const secret = process.env[`${BUILDER_ENV_PREFIX}SECRET_${i}`] || "";
    const passphrase = process.env[`${BUILDER_ENV_PREFIX}PASSPHRASE_${i}`] || "";
    if (key && secret && passphrase) {
      pool.push([key, secret, passphrase]);
    }
  }
  const key = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_KEY || "";
  const secret = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_SECRET || "";
  const passphrase = process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_PASSPHRASE || "";
  if (key && secret && passphrase) {
    const legacy: [string, string, string] = [key, secret, passphrase];
    if (!pool.some((c) => c[0] === legacy[0])) {
      pool.push(legacy);
    }
  }
  return pool;
}

export function orderedBuilderCredPool(
  credPool: Array<[string, string, string]>,
  credIndex: number,
  options?: { rotationSeconds?: number; staggerMarkets?: boolean },
): Array<[string, string, string]> {
  const n = credPool.length;
  if (n === 0) return [];
  const rs = options?.rotationSeconds ?? 0;
  let slot = 0;
  if (rs > 0 && n > 1) {
    slot = Math.floor(Date.now() / 1000 / rs) % n;
  }
  const extra =
    rs > 0 && n > 1 && !options?.staggerMarkets ? 0 : credIndex % n;
  const base = (slot + extra) % n;
  return Array.from({ length: n }, (_, i) => credPool[(base + i) % n]!);
}

function conditionIdToBytes32(conditionId: string): Hex {
  let raw = conditionId.trim();
  if (raw.startsWith("0x")) raw = raw.slice(2);
  let b = Buffer.from(raw, "hex");
  if (b.length > 32) b = b.subarray(b.length - 32);
  if (b.length < 32) {
    const padded = Buffer.alloc(32);
    b.copy(padded, 32 - b.length);
    b = padded;
  }
  return `0x${b.toString("hex")}` as Hex;
}

function encodeRedeemCalldata(
  collateralToken: string,
  conditionIdB32: Hex,
  indexSets: number[],
): Hex {
  return encodeFunctionData({
    abi: REDEEM_ABI,
    functionName: "redeemPositions",
    args: [getAddress(collateralToken), HASH_ZERO, conditionIdB32, indexSets.map(BigInt)],
  });
}

async function redeemBatchViaRelayer(options: {
  conditionIds: string[];
  privateKey: string;
  chainId: number;
  builderApiKey: string;
  builderApiSecret: string;
  builderApiPassphrase: string;
  relayerUrl?: string;
  ctfAddress?: string;
  collateralToken?: string;
  indexSets?: number[];
  depositWalletAddress?: string;
}): Promise<{ txHash: string | null; error: string | null; conditionIds: string[] }> {
  const conditionIds = options.conditionIds;
  if (conditionIds.length === 0) {
    return { txHash: null, error: "No condition_ids to redeem", conditionIds: [] };
  }

  const indexSets = options.indexSets ?? [1, 2];
  const relayerUrl = options.relayerUrl ?? RELAYER_URL;
  const collateralToken = options.collateralToken ?? PUSD_ADDRESS;

  try {
    const walletAddress = resolveDepositWalletAddress({
      privateKey: options.privateKey,
      chainId: options.chainId,
      configuredFunder: options.depositWalletAddress ?? "",
    });
    const redeemTarget =
      options.ctfAddress || redeemTargetForDepositWallet({ negRisk: false });

    const calls: DepositWalletCall[] = conditionIds.map((conditionId) => ({
      target: redeemTarget,
      value: "0",
      data: encodeRedeemCalldata(
        collateralToken,
        conditionIdToBytes32(conditionId),
        indexSets,
      ),
    }));

    const relayer = new DepositWalletRelayer({
      relayerUrl,
      chainId: options.chainId,
      privateKey: options.privateKey,
      builderApiKey: options.builderApiKey,
      builderApiSecret: options.builderApiSecret,
      builderApiPassphrase: options.builderApiPassphrase,
    });

    if (!(await relayer.isDeployed(walletAddress))) {
      return {
        txHash: null,
        error: `deposit wallet ${walletAddress} is not deployed`,
        conditionIds,
      };
    }

    const nonce = await relayer.getWalletNonce();
    const deadline = String(Math.floor(Date.now() / 1000) + 600);
    const response = await relayer.executeDepositWalletBatch({
      walletAddress,
      calls,
      nonce,
      deadline,
    });
    const result = await response.wait();
    const txHash =
      (result?.transactionHash as string | undefined) ??
      (result?.transaction_hash as string | undefined) ??
      response.transactionHash;
    if (txHash) {
      return { txHash, error: null, conditionIds };
    }
    return { txHash: null, error: "Relayer did not return transaction hash", conditionIds };
  } catch (e) {
    return { txHash: null, error: String(e), conditionIds };
  }
}

export interface RedeemBatchOptions {
  conditionIds: string[];
  privateKey: string;
  rpcUrl: string;
  chainId?: number;
  ctfAddress?: string;
  collateralToken?: string;
  indexSets?: number[];
  useRelayer?: boolean;
  credIndex?: number;
  apiKey?: string | null;
  apiSecret?: string | null;
  apiPassphrase?: string | null;
  relayerUrl?: string;
  builderCredRotationSeconds?: number;
  builderCredRotationStaggerMarkets?: boolean;
  depositWalletAddress?: string;
}

export interface RedeemResult {
  txHash: string | null;
  error: string | null;
  conditionIds: string[];
}

export async function redeemPositions(
  conditionId: string,
  options: Omit<RedeemBatchOptions, "conditionIds">,
): Promise<RedeemResult> {
  return redeemPositionsBatch({ ...options, conditionIds: [conditionId] });
}

export async function redeemPositionsBatch(options: RedeemBatchOptions): Promise<RedeemResult> {
  const conditionIds = options.conditionIds;
  if (conditionIds.length === 0) {
    return { txHash: null, error: "No condition_ids to redeem", conditionIds: [] };
  }

  let credPool = loadBuilderCredsPool();
  const useRelayer = options.useRelayer ?? true;
  if (!credPool.length && useRelayer && options.apiKey && options.apiSecret && options.apiPassphrase) {
    credPool = [[options.apiKey, options.apiSecret, options.apiPassphrase]];
  } else if (!credPool.length) {
    return {
      txHash: null,
      error:
        "Batch redeem requires relayer. Set POLYBOT5MBES_EXECUTION__BUILDER_API_KEY_1..N or api_key/secret/passphrase.",
      conditionIds,
    };
  } else if (options.apiKey && options.apiSecret && options.apiPassphrase) {
    const single: [string, string, string] = [
      options.apiKey,
      options.apiSecret,
      options.apiPassphrase,
    ];
    if (!credPool.some((c) => c[0] === single[0])) {
      credPool = [single, ...credPool];
    }
  }

  const ordered = orderedBuilderCredPool(credPool, options.credIndex ?? 0, {
    rotationSeconds: options.builderCredRotationSeconds ?? 0,
    staggerMarkets: options.builderCredRotationStaggerMarkets ?? false,
  });

  const walletBusyRetryS = 10;
  const maxWalletBusyRetries = 4;
  let lastError: string | null = null;

  for (let idx = 0; idx < ordered.length; idx += 1) {
    const [key, secret, passphrase] = ordered[idx]!;
    for (let busyTry = 0; busyTry < maxWalletBusyRetries; busyTry += 1) {
      const result = await redeemBatchViaRelayer({
        conditionIds,
        privateKey: options.privateKey,
        chainId: options.chainId ?? 137,
        builderApiKey: key,
        builderApiSecret: secret,
        builderApiPassphrase: passphrase,
        relayerUrl: options.relayerUrl,
        ctfAddress: options.ctfAddress ?? CTF_COLLATERAL_ADAPTER_ADDRESS,
        collateralToken: options.collateralToken ?? PUSD_ADDRESS,
        indexSets: options.indexSets,
        depositWalletAddress: options.depositWalletAddress,
      });
      if (!result.error) return result;
      lastError = result.error;
      if (isWalletBusyError(lastError) && busyTry < maxWalletBusyRetries - 1) {
        console.log(
          `  Relayer wallet busy — retry in ${walletBusyRetryS}s (${busyTry + 2}/${maxWalletBusyRetries})`,
        );
        await new Promise((r) => setTimeout(r, walletBusyRetryS * 1000));
        continue;
      }
      break;
    }
    if (isRateLimitError(lastError || "") && idx < ordered.length - 1) {
      console.log(`  Rate limit — retrying with next builder cred (${idx + 2}/${ordered.length})`);
    } else {
      break;
    }
  }

  return {
    txHash: null,
    error: lastError || "Redeem failed",
    conditionIds,
  };
}
