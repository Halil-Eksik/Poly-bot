/** Deposit wallet helpers for Polymarket relayer WALLET-CREATE / WALLET batches. */

import { createHmac } from "node:crypto";

import {
  type Address,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  isAddressEqual,
  keccak256,
  pad,
  type Hex,
  toBytes,
} from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";

import {
  DEPOSIT_WALLET_FACTORIES,
  DEPOSIT_WALLET_IMPLEMENTATIONS,
} from "../constants.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WALLET_TX_TYPE = "WALLET";
const WALLET_CREATE_TX_TYPE = "WALLET-CREATE";
const DEPOSIT_WALLET_DOMAIN_NAME = "DepositWallet";
const DEPOSIT_WALLET_DOMAIN_VERSION = "1";
const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973;
const TERMINAL_RELAYER_STATES = new Set(["STATE_MINED", "STATE_CONFIRMED"]);
const FAILED_RELAYER_STATE = "STATE_FAILED";

const DEPOSIT_WALLET_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
} as const;

export interface DepositWalletCall {
  target: string;
  value: string;
  data: string;
}

export function depositWalletCallToDict(call: DepositWalletCall): Record<string, string> {
  return {
    target: call.target,
    value: call.value,
    data: call.data,
  };
}

function buildHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): string {
  let message = String(timestamp) + method + requestPath;
  if (body !== undefined) {
    message += body;
  }
  const base64Secret = Buffer.from(secret, "base64");
  const sig = createHmac("sha256", base64Secret).update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

async function generateBuilderHeaders(
  method: string,
  path: string,
  body: string,
  creds: { key: string; secret: string; passphrase: string },
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const signature = buildHmacSignature(creds.secret, timestamp, method, path, body);
  return {
    POLY_BUILDER_API_KEY: creds.key,
    POLY_BUILDER_TIMESTAMP: String(timestamp),
    POLY_BUILDER_PASSPHRASE: creds.passphrase,
    POLY_BUILDER_SIGNATURE: signature,
  };
}

async function relayerGet<T>(relayerUrl: string, path: string): Promise<T | null> {
  const base = relayerUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    return null;
  }
  return (await resp.json()) as T;
}

export class RelayerSubmitResponse {
  constructor(
    readonly client: DepositWalletRelayerClient,
    readonly transactionId: string,
    readonly transactionHash: string | null,
  ) {}

  async wait(options?: { maxPolls?: number; pollFrequencyMs?: number }): Promise<Record<string, unknown> | null> {
    const maxPolls = options?.maxPolls ?? 30;
    const pollMs = options?.pollFrequencyMs ?? 2000;
    if (!this.transactionId) {
      return null;
    }
    for (let i = 0; i < maxPolls; i += 1) {
      const transactions = await this.client.getTransaction(this.transactionId);
      if (transactions.length > 0) {
        const txn = transactions[0]!;
        const state = String(txn.state ?? "");
        if (TERMINAL_RELAYER_STATES.has(state)) {
          return txn;
        }
        if (state === FAILED_RELAYER_STATE) {
          return null;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }
}

class DepositWalletRelayerClient {
  readonly relayerUrl: string;
  readonly chainId: number;
  readonly privateKey: Hex;
  readonly owner: Address;
  readonly factory: Address;
  private readonly builderCreds: { key: string; secret: string; passphrase: string };

  constructor(options: {
    relayerUrl: string;
    chainId: number;
    privateKey: string;
    builderApiKey: string;
    builderApiSecret: string;
    builderApiPassphrase: string;
  }) {
    this.relayerUrl = options.relayerUrl.replace(/\/$/, "");
    this.chainId = options.chainId;
    this.privateKey = options.privateKey.trim() as Hex;
    this.owner = privateKeyToAccount(this.privateKey).address;
    const factory = DEPOSIT_WALLET_FACTORIES[options.chainId];
    if (!factory) {
      throw new Error(`deposit wallet factory is not configured for chain_id=${options.chainId}`);
    }
    this.factory = getAddress(factory);
    this.builderCreds = {
      key: options.builderApiKey,
      secret: options.builderApiSecret,
      passphrase: options.builderApiPassphrase,
    };
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>[]> {
    const payload = await relayerGet<unknown>(
      this.relayerUrl,
      `/transaction?id=${encodeURIComponent(transactionId)}`,
    );
    return Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
  }

  private async postSubmit(body: Record<string, unknown>): Promise<RelayerSubmitResponse> {
    const bodyStr = JSON.stringify(body);
    const headers = await generateBuilderHeaders("POST", "/submit", bodyStr, this.builderCreds);
    const resp = await fetch(`${this.relayerUrl}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: bodyStr,
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`relayer submit failed status=${resp.status} body=${text}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    return new RelayerSubmitResponse(
      this,
      String(data.transactionID ?? ""),
      (data.transactionHash as string | null) ?? null,
    );
  }

  async isDeployed(walletAddress: string): Promise<boolean> {
    const wallet = getAddress(walletAddress);
    const payload = await relayerGet<{ deployed?: boolean }>(
      this.relayerUrl,
      `/deployed?address=${wallet}&type=${WALLET_TX_TYPE}`,
    );
    return Boolean(payload?.deployed);
  }

  async getWalletNonce(): Promise<string> {
    const payload = await relayerGet<{ nonce?: string | number }>(
      this.relayerUrl,
      `/nonce?address=${this.owner}&type=${WALLET_TX_TYPE}`,
    );
    if (payload?.nonce == null) {
      throw new Error("invalid WALLET nonce payload received from relayer");
    }
    return String(payload.nonce);
  }

  async deployDepositWallet(): Promise<RelayerSubmitResponse> {
    return this.postSubmit({
      type: WALLET_CREATE_TX_TYPE,
      from: this.owner,
      to: this.factory,
    });
  }

  async executeDepositWalletBatch(options: {
    walletAddress: string;
    calls: DepositWalletCall[];
    nonce: string;
    deadline: string;
  }): Promise<RelayerSubmitResponse> {
    const wallet = getAddress(options.walletAddress);
    const signature = await signDepositWalletBatch({
      privateKey: this.privateKey,
      chainId: this.chainId,
      walletAddress: wallet,
      nonce: options.nonce,
      deadline: options.deadline,
      calls: options.calls,
    });
    return this.postSubmit({
      type: WALLET_TX_TYPE,
      from: this.owner,
      to: this.factory,
      nonce: String(options.nonce),
      signature,
      depositWalletParams: {
        depositWallet: wallet,
        deadline: String(options.deadline),
        calls: options.calls.map(depositWalletCallToDict),
      },
    });
  }
}

function ownerAddress(privateKey: string): Address {
  const key = (privateKey || "").trim();
  if (!key) {
    throw new Error("private_key is required");
  }
  return privateKeyToAccount(key as Hex).address;
}

function isZeroAddress(address: string): boolean {
  return isAddressEqual(getAddress(address), getAddress(ZERO_ADDRESS));
}

function getCreate2Address(bytecodeHash: Hex, fromAddress: Address, salt: Hex): Address {
  const bytecodeHashBytes = hexToBytes(bytecodeHash);
  const fromAddressBytes = hexToBytes(fromAddress);
  const saltBytes = hexToBytes(salt);
  const addressHash = keccak256(
    new Uint8Array([0xff, ...fromAddressBytes, ...saltBytes, ...bytecodeHashBytes]),
  );
  return `0x${addressHash.slice(-40)}` as Address;
}

function initCodeHashErc1967(implementation: Address, args: Hex): Hex {
  const combined = BigInt(ERC1967_PREFIX) + (BigInt(args.length / 2 - 1) << 56n);
  const initCode = new Uint8Array([
    ...toBytes(combined, { size: 10 }),
    ...hexToBytes(implementation),
    ...hexToBytes("0x6009"),
    ...hexToBytes(ERC1967_CONST2 as Hex),
    ...hexToBytes(ERC1967_CONST1 as Hex),
    ...hexToBytes(args),
  ]);
  return keccak256(initCode);
}

async function signDepositWalletBatch(options: {
  privateKey: Hex;
  chainId: number;
  walletAddress: Address;
  nonce: string;
  deadline: string;
  calls: DepositWalletCall[];
}): Promise<Hex> {
  return signTypedData({
    privateKey: options.privateKey,
    domain: {
      name: DEPOSIT_WALLET_DOMAIN_NAME,
      version: DEPOSIT_WALLET_DOMAIN_VERSION,
      chainId: BigInt(options.chainId),
      verifyingContract: options.walletAddress,
    },
    types: DEPOSIT_WALLET_TYPES,
    primaryType: "Batch",
    message: {
      wallet: options.walletAddress,
      nonce: BigInt(options.nonce),
      deadline: BigInt(options.deadline),
      calls: options.calls.map((call) => ({
        target: getAddress(call.target),
        value: BigInt(call.value),
        data: call.data as Hex,
      })),
    },
  });
}

/** Return the deterministic deposit wallet for the owner EOA. */
export function deriveDepositWalletAddress(options: {
  privateKey: string;
  chainId: number;
}): Address {
  const owner = ownerAddress(options.privateKey);
  const factory = DEPOSIT_WALLET_FACTORIES[options.chainId];
  const implementation = DEPOSIT_WALLET_IMPLEMENTATIONS[options.chainId];
  if (!factory || !implementation) {
    throw new Error(`deposit wallet contracts are not configured for chain_id=${options.chainId}`);
  }

  const walletId = pad(owner, { size: 32 });
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [getAddress(factory), walletId],
  );
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashErc1967(getAddress(implementation), args);
  return getCreate2Address(bytecodeHash, getAddress(factory), salt);
}

/**
 * Resolve the deposit wallet used as CLOB funder and on-chain inventory holder.
 */
export function resolveDepositWalletAddress(options: {
  privateKey: string;
  chainId: number;
  configuredFunder?: string;
}): Address {
  const configured = (options.configuredFunder || "").trim();
  if (configured && !isZeroAddress(configured)) {
    return getAddress(configured);
  }
  return deriveDepositWalletAddress({
    privateKey: options.privateKey,
    chainId: options.chainId,
  });
}

export class DepositWalletRelayer {
  private readonly client: DepositWalletRelayerClient;

  constructor(options: {
    relayerUrl: string;
    chainId: number;
    privateKey: string;
    builderApiKey: string;
    builderApiSecret: string;
    builderApiPassphrase: string;
  }) {
    this.client = new DepositWalletRelayerClient(options);
  }

  isDeployed(walletAddress: string): Promise<boolean> {
    return this.client.isDeployed(walletAddress);
  }

  getWalletNonce(): Promise<string> {
    return this.client.getWalletNonce();
  }

  executeDepositWalletBatch(options: {
    walletAddress: string;
    calls: DepositWalletCall[];
    nonce: string;
    deadline: string;
  }): Promise<RelayerSubmitResponse> {
    return this.client.executeDepositWalletBatch(options);
  }

  /** Deploy via relayer when wallet is missing. */
  deployDepositWallet(): Promise<RelayerSubmitResponse> {
    return this.client.deployDepositWallet();
  }
}

export async function ensureDepositWalletDeployed(options: {
  relayerUrl: string;
  chainId: number;
  privateKey: string;
  builderApiKey: string;
  builderApiSecret: string;
  builderApiPassphrase: string;
  walletAddress: string;
}): Promise<string | null> {
  const relayer = new DepositWalletRelayer(options);
  const wallet = getAddress(options.walletAddress);
  if (await relayer.isDeployed(wallet)) {
    return null;
  }
  const response = await relayer.deployDepositWallet();
  const result = await response.wait();
  if (result) {
    return String(result.transactionHash ?? result.transaction_hash ?? "");
  }
  return response.transactionHash;
}
