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

export interface Transfer {
  heir: string;
  asset: "Near" | "Eth";
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
}

export interface ContractConfig {
  admin: string;
  mpc_contract: string;
  eth_chain_id: number;
  eth_max_fee_cap: string;
  eth_initial_max_fee: string;
  eth_priority_fee: string;
  eth_gas_limit: number;
  paused: boolean;
  executors: string[];
  demo_timers: boolean;
}
