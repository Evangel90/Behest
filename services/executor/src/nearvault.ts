// NEAR vault sweeper: moves NEAR sent to a plan's NEAR vault (an implicit
// account whose key MPC derives for the contract) into the plan's escrow.
// The contract builds and signs the only transaction the vault can send, a
// `deposit({owner})` call on itself; this module only picks the amount,
// nonce and block hash, asks for the signature and broadcasts it.
import { JsonRpcProvider, teraToGas, Account, type KeyPairString } from "near-api-js";

export const YOCTO_PER_BYTE = 10_000_000_000_000_000_000n; // 1e19
/**
 * Left in the vault for the sweep's own gas. NEAR checks prepaid gas at a
 * pessimistic price (≈0.011 NEAR for the 10 Tgas call on testnet); what isn't
 * burnt is refunded to the vault and goes out with the next sweep.
 */
export const GAS_RESERVE = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
/** Don't sweep dust. */
export const MIN_SWEEP = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

export interface Sweep {
  nonce: number;
  amount: string;
  signed_tx: string | null;
}

export interface NearVaultPort {
  /** [owner, vault account id]. */
  listVaults(): Promise<[string, string][]>;
  account(id: string): Promise<{ amount: bigint; storageUsage: number } | null>;
  accessKeyNonce(id: string, publicKey: string): Promise<bigint | null>;
  vaultPublicKey(owner: string): Promise<string>;
  blockHash(): Promise<string>;
  requestSweep(owner: string, amount: bigint, nonce: bigint, blockHash: string): Promise<void>;
  getSweep(owner: string): Promise<Sweep | null>;
  /** Returns the transaction hash; throws with the node's error. */
  broadcast(signedTxBase64: string): Promise<string>;
}

export type SweepOutcome = "empty" | "swept" | "unsigned" | "failed";

/** What can be swept from a vault holding `amount` with `storageUsage` bytes. */
export function sweepable(amount: bigint, storageUsage: number): bigint {
  const free = amount - BigInt(storageUsage) * YOCTO_PER_BYTE - GAS_RESERVE;
  return free >= MIN_SWEEP ? free : 0n;
}

export async function sweepVaults(p: NearVaultPort, log: (msg: string, data?: Record<string, unknown>) => void): Promise<Map<string, SweepOutcome>> {
  const out = new Map<string, SweepOutcome>();
  for (const [owner, id] of await p.listVaults()) {
    try {
      const acct = await p.account(id);
      const amount = acct ? sweepable(acct.amount, acct.storageUsage) : 0n;
      if (!amount) {
        out.set(owner, "empty");
        continue;
      }
      const nonce = await p.accessKeyNonce(id, await p.vaultPublicKey(owner));
      if (nonce === null) {
        out.set(owner, "empty");
        continue;
      }
      // A signed sweep for the next nonce that this balance still covers: send it again.
      let s = await p.getSweep(owner);
      if (!(s?.signed_tx && BigInt(s.nonce) === nonce + 1n && BigInt(s.amount) <= amount)) {
        await p.requestSweep(owner, amount, nonce + 1n, await p.blockHash());
        s = await p.getSweep(owner);
      }
      if (!s?.signed_tx) {
        out.set(owner, "unsigned");
        log("near vault sweep not signed yet", { owner });
        continue;
      }
      const hash = await p.broadcast(s.signed_tx);
      out.set(owner, "swept");
      log("near vault swept", { owner, vault: id, amount: s.amount, tx: hash });
    } catch (e) {
      out.set(owner, "failed");
      log("near vault sweep failed", { owner, vault: id, error: String(e) });
    }
  }
  return out;
}

export function createNearVaultPort(o: { rpcUrl: string; contractId: string; executorAccountId: string; executorPrivateKey: KeyPairString }): NearVaultPort {
  const provider = new JsonRpcProvider({ url: o.rpcUrl });
  const account = new Account(o.executorAccountId, provider, o.executorPrivateKey);
  const view = <T>(method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId: o.contractId, method, args }) as Promise<T>;
  const keys = new Map<string, string>();
  return {
    async listVaults() {
      const all: [string, string][] = [];
      for (let from = 0; ; from += 100) {
        const page = await view<[string, string][]>("get_near_vaults", { from_index: from, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
    async account(id) {
      try {
        const a = (await provider.viewAccount({ accountId: id })) as unknown as { amount: bigint | string; storage_usage?: number; storageUsage?: number };
        return { amount: BigInt(a.amount), storageUsage: Number(a.storage_usage ?? a.storageUsage ?? 0) };
      } catch (e) {
        if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e))) return null;
        throw e;
      }
    },
    async accessKeyNonce(id, publicKey) {
      try {
        const k = (await provider.viewAccessKey({ accountId: id, publicKey })) as unknown as { nonce: bigint | number | string };
        return BigInt(k.nonce);
      } catch (e) {
        if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i.test(String(e))) return null;
        throw e;
      }
    },
    async vaultPublicKey(owner) {
      const hit = keys.get(owner);
      if (hit) return hit;
      const v = await view<{ public_key: string } | null>("get_near_vault", { owner });
      if (!v) throw new Error("no NEAR vault");
      keys.set(owner, v.public_key);
      return v.public_key;
    },
    async blockHash() {
      const b = (await provider.viewBlock({ finality: "final" })) as unknown as { header: { hash: string } };
      return b.header.hash;
    },
    async requestSweep(owner, amount, nonce, blockHash) {
      await account.callFunction({ contractId: o.contractId, methodName: "sweep_near_vault", args: { owner, amount: amount.toString(), nonce: Number(nonce), block_hash: blockHash }, gas: teraToGas(120) });
    },
    getSweep: (owner) => view<Sweep | null>("get_near_vault_sweep", { owner }),
    async broadcast(signed) {
      const r = (await provider.sendJsonRpc("send_tx", { signed_tx_base64: signed, wait_until: "EXECUTED_OPTIMISTIC" })) as { transaction?: { hash: string }; transaction_outcome?: { id: string } };
      return r.transaction?.hash ?? r.transaction_outcome?.id ?? "";
    },
  };
}
