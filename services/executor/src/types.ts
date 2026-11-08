// Mirrors contracts/behest/src/types.rs (JSON shapes).

export type TransferState = "Pending" | "Sending" | "Signing" | "Signed" | "Broadcast" | "Confirmed" | "Failed";

export interface EthTxParams {
  chain_id: number;
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  payload_hash: string;
  gas_limit: number;
}

export interface Transfer {
  heir: string;
  /** ERC-20 transfers carry the lowercase token address. */
  asset: Asset;
  destination: string;
  amount: string;
  state: TransferState;
  eth_tx: EthTxParams | null;
  signature: { big_r: string; s: string; recovery_id: number } | null;
  attempts: number;
  tx_hash: string | null;
  failure: string | null;
}

export type Asset = "Near" | "Eth" | { Erc20: string };

/** Paid from the plan's Ethereum vault (ETH or an allowlisted ERC-20). */
export const isEvm = (a: Asset) => a !== "Near";

/**
 * The exact call a vault transaction must make for a transfer: ETH goes to the
 * heir; a token transfer calls the token's `transfer(heir, amount)`.
 * Mirrors `evm_call` in contracts/behest/src/lib.rs.
 */
export function expectedCall(t: Pick<Transfer, "asset" | "destination" | "amount">): { to: string; value: bigint; data: string } {
  if (t.asset === "Near") throw new Error("not an EVM transfer");
  if (t.asset === "Eth") return { to: t.destination.toLowerCase(), value: BigInt(t.amount), data: "0x" };
  const word = (hex: string) => hex.padStart(64, "0");
  const data = `0xa9059cbb${word(t.destination.toLowerCase().slice(2))}${word(BigInt(t.amount).toString(16))}`;
  return { to: t.asset.Erc20.toLowerCase(), value: 0n, data };
}

/** Transfer index that addresses the owner's vault withdrawal (contract D7). */
export const VAULT_WITHDRAWAL = 4294967295;

export interface PlanView {
  plan: {
    owner: string;
    version: number;
    proposal: { id: number; transfers: Transfer[] } | null;
  };
  status: string;
}

export interface ContractConfig {
  eth_max_fee_cap: string;
  eth_chain_id: number;
  mpc_contract: string;
}

/** Contract-side operations (NEAR). */
export interface NearPort {
  config(): Promise<ContractConfig>;
  listOpenReleases(): Promise<string[]>;
  getPlan(owner: string): Promise<PlanView | null>;
  getSignedTx(owner: string, index: number): Promise<string | null>;
  /** All signed versions of a transfer (same nonce, different fees), oldest first. */
  getSignedTxVersions(owner: string, index: number): Promise<string[]>;
  vaultAddress(owner: string): Promise<`0x${string}`>;
  reportBroadcast(owner: string, index: number, txHash: string): Promise<void>;
  reportConfirmed(owner: string, index: number, txHash: string): Promise<void>;
  reportFailed(owner: string, index: number, reason: string): Promise<void>;
  retryTransfer(owner: string, index: number): Promise<void>;
  /** Owners whose vault withdrawal is unresolved. */
  listVaultWithdrawals(): Promise<string[]>;
  getVaultWithdrawal(owner: string): Promise<Transfer | null>;
  /** Re-sign a failed, never-broadcast withdrawal's nonce as a 0-ETH transfer. */
  cancelVaultWithdrawal(owner: string): Promise<void>;
}

export interface Receipt {
  blockNumber: bigint;
  success: boolean;
}

/** Destination-chain operations (Sepolia). */
export interface EthPort {
  sendRaw(raw: `0x${string}`): Promise<`0x${string}`>;
  receipt(hash: `0x${string}`): Promise<Receipt | null>;
  /** True if the node knows the tx (mempool or mined). */
  known(hash: `0x${string}`): Promise<boolean>;
  blockNumber(): Promise<bigint>;
  /** Count of mined txs from `address` (the next usable nonce). */
  minedNonce(address: `0x${string}`): Promise<number>;
  /**
   * Gas the call `from → to` (value, calldata) needs right now, or "reverts"
   * when the node's simulation reverts (e.g. the vault lacks the token).
   * Other errors (RPC trouble) are thrown.
   */
  estimateTransferGas(from: `0x${string}`, to: `0x${string}`, value: bigint, data?: `0x${string}`): Promise<bigint | "reverts">;
}

/**
 * Per-transfer timing hints. Not needed for correctness: every signed version
 * lives in the contract, so a fresh executor with an empty store recovers.
 */
export interface TransferMemory {
  /** Hashes this executor broadcast (an optimisation; the contract is the source). */
  hashes: `0x${string}`[];
  broadcastAt?: number;
  lastRetryAt?: number;
}

export interface Store {
  get(key: string): TransferMemory;
  set(key: string, m: TransferMemory): void;
}
