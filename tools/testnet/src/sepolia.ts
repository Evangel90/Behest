// Shared Sepolia helpers for the live scenarios and admin tools.
import { Engine } from "@behest/executor/engine";
import { createEthPort } from "@behest/executor/eth";
import { createNearPort, ethAddressFromMpcKey } from "@behest/executor/near";
import { memoryStore } from "@behest/executor/store";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ROOT, keyOf, log, provider, view } from "./near.js";

export const transport = http(process.env.SEPOLIA_RPC_URL?.trim() || undefined);
export const pub = createPublicClient({ chain: sepolia, transport });

export function funderAccount() {
  const raw = (process.env.SEPOLIA_FUNDER_KEY ?? "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error("SEPOLIA_FUNDER_KEY must be a 32-byte hex private key (not an address)");
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

// Generated heir wallets per plan owner, kept out of git (.testnet-wallets.json).
const WALLETS_FILE = join(ROOT, ".testnet-wallets.json");
export type HeirKeys = { amara: Hex; tobi: Hex };
export function loadWallets(): Record<string, HeirKeys> {
  return existsSync(WALLETS_FILE) ? JSON.parse(readFileSync(WALLETS_FILE, "utf8")) : {};
}
export function saveWallets(owner: string, keys: HeirKeys) {
  writeFileSync(WALLETS_FILE, JSON.stringify({ ...loadWallets(), [owner]: keys }, null, 2), { mode: 0o600 });
}

/** Sends a test wallet's whole balance back to `to` (legacy tx: cost is exactly gas × price). */
export async function sweep(key: Hex, to: Hex): Promise<bigint> {
  const acct = privateKeyToAccount(key);
  const bal = await pub.getBalance({ address: acct.address });
  const gasPrice = (await pub.getGasPrice()) * 2n;
  const gas = await pub.estimateGas({ account: acct.address, to, value: 1n });
  const cost = gas * gasPrice;
  if (bal <= cost) return 0n;
  const w = createWalletClient({ chain: sepolia, transport, account: acct });
  const hash = await w.sendTransaction({ to, value: bal - cost, gas, gasPrice, type: "legacy" });
  await pub.waitForTransactionReceipt({ hash });
  return bal - cost;
}

export async function vaultOf(contract: string, owner: string): Promise<Hex> {
  const key = (await provider.callFunction({
    contractId: process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet",
    method: "derived_public_key",
    args: { path: await view<string>(contract, "get_eth_vault_path", { owner }), predecessor: contract, domain_id: 0 },
  })) as string;
  return ethAddressFromMpcKey(key);
}

export function executor(contract: string, executorAccountId: string) {
  return new Engine(
    createNearPort({
      rpcUrl: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com",
      contractId: contract,
      executorAccountId,
      executorPrivateKey: keyOf(executorAccountId),
    }),
    createEthPort(process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com"),
    memoryStore(),
    { confirmations: 3, stuckAfterMs: 10 * 60_000, retryBackoffMs: 60_000, now: Date.now, log: (m, x) => log(`executor: ${m}`, x) },
  );
}
