// Read-only access to the Behest contract, the MPC vault and Sepolia.
import { JsonRpcProvider, baseDecode } from "near-api-js";
import { bytesToHex, createPublicClient, http, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CONTRACT_ID, MPC_CONTRACT, NEAR_RPC, SEPOLIA_RPC } from "./config";
import type { ContractConfig, PlanView } from "./types";

export const provider = new JsonRpcProvider({ url: NEAR_RPC });
export const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT_ID): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const getPlan = (owner: string) => view<PlanView | null>("get_plan", { owner });
export const getConfig = () => view<ContractConfig>("get_config");
export const listOpenReleases = () => view<string[]>("list_open_releases", { from_index: 0, limit: 100 });

export async function nearBalance(accountId: string): Promise<bigint | null> {
  try {
    const a = await provider.viewAccount({ accountId });
    return BigInt(a.amount);
  } catch {
    return null;
  }
}

/** Sepolia address controlled by the plan through Chain Signatures. */
export async function vaultAddress(owner: string): Promise<Hex> {
  const path = await view<string>("get_eth_vault_path", { owner });
  const key = await view<string>("derived_public_key", { path, predecessor: CONTRACT_ID, domain_id: 0 }, MPC_CONTRACT);
  const raw = baseDecode(key.replace(/^secp256k1:/, ""));
  return publicKeyToAddress(`0x04${bytesToHex(raw).slice(2)}` as Hex);
}

export const ethBalance = (address: Hex) => sepoliaClient.getBalance({ address });
