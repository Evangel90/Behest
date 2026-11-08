// Read-only access to the Behest contract, the MPC vault and Sepolia.
import { JsonRpcProvider, baseDecode } from "near-api-js";
import { bytesToHex, createPublicClient, erc20Abi, http, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CONTRACT_ID, MPC_CONTRACT, NEAR_RPC, SEPOLIA_RPC } from "./config";
import { registerTokens } from "./plan";
import type { ContractConfig, Erc20Token, PlanView, Transfer } from "./types";

export const provider = new JsonRpcProvider({ url: NEAR_RPC });
export const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT_ID): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const getPlan = (owner: string) => view<PlanView | null>("get_plan", { owner });
/** The owner's latest vault withdrawal (contract D7). */
export const getVaultWithdrawal = (owner: string) => view<Transfer | null>("get_vault_withdrawal", { owner });
export async function getConfig() {
  const cfg = await view<ContractConfig>("get_config");
  registerTokens(cfg.erc20_tokens ?? [], cfg.nep141_tokens ?? []);
  return cfg;
}
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

/** Vault balance of each allowlisted token (null where the read failed). */
export function tokenBalances(address: Hex, tokens: Erc20Token[]) {
  return Promise.all(
    tokens.map((t) => sepoliaClient.readContract({ address: t.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => null)),
  );
}
