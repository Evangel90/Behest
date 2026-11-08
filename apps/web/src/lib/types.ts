// JSON shapes returned by the Behest contract (contracts/behest/src/types.rs).

export type PlanStatus = "Active" | "Overdue" | "Proposed" | "Waiting" | "Eligible" | "Executing" | "Settled";
export type TransferState = "Pending" | "Sending" | "Signing" | "Signed" | "Broadcast" | "Confirmed" | "Failed";

export interface HeirInput {
  account_id: string;
  share_bps: number;
  near_destination: string | null;
  eth_destination: string | null;
}

export interface PlanInput {
  check_in_interval_ms: number;
  grace_ms: number;
  waiting_period_ms: number;
  guardians: string[];
  quorum: number;
  heirs: HeirInput[];
}

/** ERC-20 transfers carry the lowercase token address. */
export type Asset = "Near" | "Eth" | "Btc" | { Erc20: string } | { Nep141: string };

export interface Nep141Token {
  account_id: string;
  symbol: string;
  decimals: number;
  storage_deposit: string;
}

export interface Erc20Token {
  address: string;
  symbol: string;
  decimals: number;
}

export interface Transfer {
  heir: string;
  asset: Asset;
  destination: string;
  amount: string;
  state: TransferState;
  eth_tx: { chain_id: number; nonce: number; max_fee_per_gas: string; max_priority_fee_per_gas: string; payload_hash: string; gas_limit: number } | null;
  attempts: number;
  tx_hash: string | null;
  failure: string | null;
}

export interface Proposal {
  id: number;
  plan_version: number;
  proposer: string;
  created_at_ms: number;
  approvals: string[];
  rejections: string[];
  approved_at_ms: number | null;
  waiting_ends_at_ms: number | null;
  near_snapshot: string;
  eth_snapshot: string;
  eth_fee_reserve: string;
  eth_gas_limit: number;
  transfers: Transfer[];
}

export interface Plan {
  owner: string;
  version: number;
  policy: PlanInput;
  last_check_in_ms: number;
  escrow: string;
  eth_next_nonce: number;
  proposal: Proposal | null;
  proposals_opened: number;
}

export interface PlanView {
  status: PlanStatus;
  overdue_at_ms: number;
  now_ms: number;
  plan: Plan;
  /** NEP-141 balances held for the plan (older contracts omit it). */
  ft_escrow?: { token: string; amount: string }[];
}

export interface ContractConfig {
  admin: string;
  mpc_contract: string;
  eth_chain_id: number;
  eth_max_fee_cap: string;
  eth_initial_max_fee: string;
  eth_priority_fee: string;
  eth_gas_limit: number;
  erc20_tokens: Erc20Token[];
  nep141_tokens?: Nep141Token[];
  /** Bitcoin fee rates in sat/vB (contract D20; absent on older contracts). */
  btc?: { fee_rate: number; max_fee_rate: number };
  paused: boolean;
  executors: string[];
  demo_timers: boolean;
}

/** Someone who can receive in place of a heir (alternate or fallback). */
export interface Recipient {
  account_id: string;
  near_destination: string | null;
  eth_destination: string | null;
}

/** Optional per-plan release rules (contract D17). */
export interface ReleaseRules {
  fixed: { heir: string; asset: Asset; amount: string }[];
  remainder_to: string | null;
  alternates: { heir: string; recipient: Recipient }[];
  fallback: Recipient | null;
  claim_window_ms: number;
}

/** Release mode and delay signers (contract D18, D19). */
export interface ReleaseOptions {
  mode: "Claim" | "Automatic" | "Hybrid";
  hybrid_grace_ms: number;
  delay_signers: string[];
  delay_quorum: number;
  max_extension_ms: number;
  max_total_extension_ms: number;
  /** Per heir and/or asset group; first match wins. Absent on older contracts. */
  overrides?: ModeOverride[];
}

export interface ModeOverride {
  heir: string | null;
  assets: "All" | "Near" | "Ethereum" | "Bitcoin";
  mode: ReleaseOptions["mode"];
  hybrid_grace_ms: number;
}

export interface ExtensionState {
  proposal_id: number;
  total_ms: number;
  count: number;
  pending: { extension_ms: number; reason: string | null; votes: string[] } | null;
}

/** Bitcoin (contract D20). */
export interface BtcUtxo {
  txid: string;
  vout: number;
  value: string;
}

export interface BtcDestination {
  account_id: string;
  address: string;
}

export interface BtcVault {
  path: string;
  pubkey: string;
  address: string;
}

export interface BtcTx {
  inputs: BtcUtxo[];
  outputs: { script: string; value: string }[];
  fee_rate: number;
  fee: string;
  seq: number;
  txid: string;
  raw: string | null;
}

export interface BtcRelease {
  proposal_id: number;
  snapshot: BtcUtxo[];
  reserve: string;
  head: BtcUtxo[];
  signed: number;
  last: number | null;
}
