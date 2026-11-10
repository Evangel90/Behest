// Read-only access to the Behest contract, the MPC vault and Sepolia.
import { JsonRpcProvider, baseDecode } from "near-api-js";
import { bytesToHex, createPublicClient, erc20Abi, http, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { BTC_ESPLORA, CONTRACT_ID, MPC_CONTRACT, NEAR_RPC, SEPOLIA_RPC } from "./config";
import { registerTokens } from "./plan";
import type { BtcDestination, BtcRelease, BtcTx, BtcUtxo, BtcVault, ContractConfig, Erc20Token, PlanView, Proposal, Transfer } from "./types";

export const provider = new JsonRpcProvider({ url: NEAR_RPC });
export const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

/** Rate limits and network blips, as opposed to a contract error that would fail again. */
export function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/does not exist|panicked|MethodNotFound|CodeDoesNotExist|wasm execution failed/i.test(m)) return false;
  return /429|rate limit|too many|failed to fetch|fetch failed|network|timeout|timed out|ECONN|socket|\b50[0234]\b|bad gateway|unavailable/i.test(m);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Contract view call; retries transient RPC failures (public RPCs rate-limit bursts). */
export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT_ID): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await provider.callFunction({ contractId, method, args })) as T;
    } catch (e) {
      if (attempt >= 4 || !isTransient(e)) throw e;
      await sleep(500 * 2 ** attempt + Math.random() * 400);
    }
  }
}

export const getPlan = (owner: string) => view<PlanView | null>("get_plan", { owner });
/** The owner's latest vault withdrawal (contract D7). */
export const getVaultWithdrawal = (owner: string) => view<Transfer | null>("get_vault_withdrawal", { owner });
/** D21: settled releases, oldest first (a settled one not yet archived included). */
export const getReleaseHistory = (owner: string) => view<Proposal[]>("get_release_history", { owner });
// Many components need the config; share one read for a minute instead of one each.
let configCache: { at: number; p: Promise<ContractConfig> } | null = null;
export function getConfig(): Promise<ContractConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.p;
  const p = view<ContractConfig>("get_config").then((cfg) => {
    registerTokens(cfg.erc20_tokens ?? [], cfg.nep141_tokens ?? []);
    return cfg;
  });
  configCache = { at: Date.now(), p };
  p.catch(() => {
    if (configCache?.p === p) configCache = null;
  });
  return p;
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
// A plan's vault address never changes, so derive it once per owner.
const vaultCache = new Map<string, Promise<Hex>>();
export function vaultAddress(owner: string): Promise<Hex> {
  let p = vaultCache.get(owner);
  if (!p) {
    p = deriveVaultAddress(owner);
    vaultCache.set(owner, p);
    p.catch(() => vaultCache.delete(owner));
  }
  return p;
}
async function deriveVaultAddress(owner: string): Promise<Hex> {
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

// ------------------------------------------------------------ bitcoin (D20)

export const getBtcVault = (owner: string) => view<BtcVault | null>("get_btc_vault", { owner });
export const getBtcDestinations = (owner: string) => view<BtcDestination[]>("get_btc_destinations", { owner });
export const getBtcRelease = (owner: string) => view<BtcRelease | null>("get_btc_release", { owner });
export const getBtcTx = (owner: string, index: number) => view<BtcTx | null>("get_btc_tx", { owner, index });

/** Confirmed coins at a testnet address, largest first. */
export async function btcUtxos(address: string): Promise<BtcUtxo[]> {
  const r = await fetch(`${BTC_ESPLORA}/address/${address}/utxo`);
  if (!r.ok) throw new Error(`Bitcoin API: ${r.status}`);
  const list = (await r.json()) as { txid: string; vout: number; value: number; status: { confirmed: boolean } }[];
  return list
    .filter((u) => u.status.confirmed)
    .sort((a, b) => b.value - a.value)
    .map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.value) }));
}

/** At most this many coins per payout (each needs its own MPC signature). */
export const MAX_BTC_INPUTS = 2;

// ------------------------------------------------- Ethereum wallets (D23/D24)

/** The contract has no such method (a deployment from before it was added). */
export const isMissingMethod = (e: unknown) => /MethodNotFound|MethodResolveError|method .*not found|does not exist/i.test(e instanceof Error ? `${e.name} ${e.message}` : JSON.stringify(e));

/** Next signed-action nonce of an Ethereum account (0x…), as the contract counts them. */
export async function getEvmNonce(account: string): Promise<bigint> {
  const n = await view<string | number>("get_evm_nonce", { account: account.toLowerCase() });
  return BigInt(n);
}

export interface Sponsorship {
  pool: string;
  allowance_left: string;
  daily_left: number;
}
/** What Behest's sponsor pool can still cover for an owner's storage (D24); null on a contract without the pool. */
export async function getSponsorship(owner: string): Promise<Sponsorship | null> {
  try {
    return await view<Sponsorship>("get_sponsorship", { owner });
  } catch (e) {
    if (isMissingMethod(e)) return null;
    throw e;
  }
}

/** Whether the pool can cover an owner's next storage-growing change. The contract has the final say. */
export const sponsorshipAvailable = (s: Sponsorship | null, newPlan: boolean) => !!s && BigInt(s.allowance_left) > 0n && BigInt(s.pool) > 0n && (!newPlan || s.daily_left > 0);
