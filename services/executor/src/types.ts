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
  asset: "Near" | "Eth";
  destination: string;
  amount: string;
  state: TransferState;
  eth_tx: EthTxParams | null;
  signature: { big_r: string; s: string; recovery_id: number } | null;
  attempts: number;
  tx_hash: string | null;
  failure: string | null;
}

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
  /** Gas a plain value transfer `from → to` needs right now. */
  estimateTransferGas(from: `0x${string}`, to: `0x${string}`, value: bigint): Promise<bigint>;
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
