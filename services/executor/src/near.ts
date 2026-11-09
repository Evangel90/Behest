import { Account, JsonRpcProvider, baseDecode, teraToGas, type KeyPairString } from "near-api-js";
import { bytesToHex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { BtcTx, ContractConfig, NearPort, PlanView, ReleaseOptions, Transfer } from "./types.js";

export interface NearOptions {
  rpcUrl: string;
  contractId: string;
  executorAccountId: string;
  executorPrivateKey: KeyPairString;
}

/** Ethereum address for a NEAR MPC `secp256k1:<base58 64-byte key>` public key. */
export function ethAddressFromMpcKey(key: string): `0x${string}` {
  const raw = baseDecode(key.replace(/^secp256k1:/, ""));
  if (raw.length !== 64) throw new Error(`unexpected MPC key length ${raw.length}`);
  return publicKeyToAddress(`0x04${bytesToHex(raw).slice(2)}`);
}

export function createNearPort(o: NearOptions): NearPort {
  const provider = new JsonRpcProvider({ url: o.rpcUrl });
  const account = new Account(o.executorAccountId, provider, o.executorPrivateKey);
  const vaults = new Map<string, `0x${string}`>();
  let cachedConfig: ContractConfig | undefined;

  const view = <T>(method: string, args: Record<string, unknown> = {}) =>
    provider.callFunction({ contractId: o.contractId, method, args }) as Promise<T>;
  const call = (methodName: string, args: Record<string, unknown>, tgas = 30) =>
    account.callFunction({ contractId: o.contractId, methodName, args, gas: teraToGas(tgas) }).then(() => undefined);

  return {
    async config() {
      cachedConfig ??= await view<ContractConfig>("get_config");
      return cachedConfig;
    },
    async listOpenReleases() {
      const all: string[] = [];
      for (let from = 0; ; from += 100) {
        const page = await view<string[]>("list_open_releases", { from_index: from, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
    getPlan: (owner) => view<PlanView | null>("get_plan", { owner }),
    getSignedTx: (owner, index) => view<string | null>("get_signed_tx", { owner, index }),
    getSignedTxVersions: (owner, index) => view<string[]>("get_signed_tx_versions", { owner, index }),
    async vaultAddress(owner) {
      const hit = vaults.get(owner);
      if (hit) return hit;
      const { mpc_contract } = await this.config();
      const path = await view<string>("get_eth_vault_path", { owner });
      const key = (await provider.callFunction({
        contractId: mpc_contract,
        method: "derived_public_key",
        args: { path, predecessor: o.contractId, domain_id: 0 },
      })) as string;
      const addr = ethAddressFromMpcKey(key);
      vaults.set(owner, addr);
      return addr;
    },
    reportBroadcast: (owner, index, tx_hash) => call("report_broadcast", { owner, index, tx_hash }),
    reportConfirmed: (owner, index, tx_hash) => call("report_confirmed", { owner, index, tx_hash }),
    reportFailed: (owner, index, reason) => call("report_failed", { owner, index, reason }),
    // MPC sign (50 Tgas per signature; a Bitcoin payout signs up to 2 inputs) + callback + headroom.
    retryTransfer: (owner, index) => call("retry_transfer", { owner, index }, 200),
    listVaultWithdrawals: () => view<string[]>("list_vault_withdrawals"),
    getVaultWithdrawal: (owner) => view<Transfer | null>("get_vault_withdrawal", { owner }),
    cancelVaultWithdrawal: (owner) => call("cancel_vault_withdrawal", { owner }, 150),
    getReleaseOptions: (owner) => view<ReleaseOptions | null>("get_release_options", { owner }),
    release: (owner, heir) => call("release", { owner, heir }, 300),
    getBtcTx: (owner, index) => view<BtcTx | null>("get_btc_tx", { owner, index }),
    getBtcRelease: (owner) => view<{ last: number | null } | null>("get_btc_release", { owner }),
    getBtcTxVersions: (owner, index) => view<BtcTx[]>("get_btc_tx_versions", { owner, index }),
    async ethBlockFinal(blockNumber) {
      const lc = (await this.config()).eth_light_client;
      if (!lc) return false;
      const n = Buffer.alloc(8);
      n.writeBigUInt64LE(blockNumber);
      // block_hash_safe takes and returns borsh: Option<[u8; 32]>
      const r = (await provider.query({
        request_type: "call_function",
        account_id: lc,
        method_name: "block_hash_safe",
        args_base64: n.toString("base64"),
        finality: "final",
      } as never)) as unknown as { result: number[] };
      return r.result[0] === 1;
    },
    proveEthOutcome: (owner, index, proof) => call("prove_eth_outcome", { owner, index, proof }, 150),
    getRevertProof: (owner, index) => view<string | null>("get_revert_proof", { owner, index }),
    reissueReverted: (owner, index) => call("reissue_reverted_transfer", { owner, index }, 200),
    btcVaultAddress: async (owner) => (await view<{ address: string } | null>("get_btc_vault", { owner }))?.address ?? null,
  };
}
