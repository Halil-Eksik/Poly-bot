/** Read conditional token balances from the CTF (ERC-1155) on Polygon. */

import { createPublicClient, http, type Address } from "viem";
import { polygon } from "viem/chains";

import { CTF_ADDRESS } from "../constants.js";

const CTF_BALANCE_ABI = [
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const CONDITIONAL_DECIMALS = 1_000_000;

export async function fetchCtfOutcomeBalancesShares(
  rpcUrl: string,
  wallet: string,
  yesTokenId: string,
  noTokenId: string,
): Promise<[number, number] | null> {
  const rpc = (rpcUrl || "").trim();
  const w = (wallet || "").trim();
  if (!rpc || !w) {
    return null;
  }

  try {
    const client = createPublicClient({
      chain: polygon,
      transport: http(rpc),
    });
    const owner = w as Address;
    const contract = { address: CTF_ADDRESS as Address, abi: CTF_BALANCE_ABI };
    const [yesRaw, noRaw] = await Promise.all([
      client.readContract({
        ...contract,
        functionName: "balanceOf",
        args: [owner, BigInt(yesTokenId)],
      }),
      client.readContract({
        ...contract,
        functionName: "balanceOf",
        args: [owner, BigInt(noTokenId)],
      }),
    ]);
    return [Number(yesRaw) / CONDITIONAL_DECIMALS, Number(noRaw) / CONDITIONAL_DECIMALS];
  } catch (err) {
    console.warn(
      `CTF balanceOf failed wallet=${w} yes=${yesTokenId} no=${noTokenId}:`,
      err,
    );
    return null;
  }
}

export async function readCtfPositionBalanceRaw(
  rpcUrl: string,
  walletAddress: string,
  tokenId: string,
): Promise<number> {
  const rpc = (rpcUrl || "").trim();
  const wallet = (walletAddress || "").trim();
  if (!rpc || !wallet) {
    return 0;
  }
  try {
    const client = createPublicClient({
      chain: polygon,
      transport: http(rpc),
    });
    const raw = await client.readContract({
      address: CTF_ADDRESS as Address,
      abi: CTF_BALANCE_ABI,
      functionName: "balanceOf",
      args: [wallet as Address, BigInt(tokenId)],
    });
    return Number(raw);
  } catch {
    return 0;
  }
}
