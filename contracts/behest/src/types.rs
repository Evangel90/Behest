use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Owner-supplied plan. See docs/stage0/04-policy-schema.md.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PlanInput {
    pub check_in_interval_ms: u64,
    pub grace_ms: u64,
    pub waiting_period_ms: u64,
    pub guardians: Vec<AccountId>,
    pub quorum: u8,
    pub heirs: Vec<HeirInput>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HeirInput {
    /// Account that authorizes `claim`.
    pub account_id: AccountId,
    /// Basis points; all heirs sum to 10_000.
    pub share_bps: u16,
    pub near_destination: Option<AccountId>,
    /// `0x` + 40 hex chars, stored lowercase.
    pub eth_destination: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub owner: AccountId,
    pub version: u32,
    pub policy: PlanInput,
    pub last_check_in_ms: u64,
    /// NEAR held for this plan and not reserved by a proposal.
    pub escrow: U128,
    /// Next nonce of the plan's Sepolia vault (only this contract signs for it).
    pub eth_next_nonce: u64,
    pub proposal: Option<Proposal>,
    pub proposals_opened: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub plan_version: u32,
    pub proposer: AccountId,
    pub created_at_ms: u64,
    pub approvals: Vec<AccountId>,
    pub rejections: Vec<AccountId>,
    pub approved_at_ms: Option<u64>,
    /// Last owner-cancellation point. No signature may be requested before it.
    pub waiting_ends_at_ms: Option<u64>,
    pub near_snapshot: U128,
    pub eth_snapshot: U128,
    pub eth_fee_reserve: U128,
    pub transfers: Vec<Transfer>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asset {
    Near,
    Eth,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Transfer {
    pub heir: AccountId,
    pub asset: Asset,
    pub destination: String,
    pub amount: U128,
    pub state: TransferState,
    /// ETH only: fixed nonce plus the fees of the latest signing attempt.
    pub eth_tx: Option<EthTxParams>,
    /// ETH only: MPC signature for `eth_tx`.
    pub signature: Option<EthSignature>,
    /// Every signature obtained for this transfer, oldest first. All share one
    /// nonce, so at most one can ever be mined; keeping them lets any executor
    /// find the one that landed without local state. Bounded by MAX_SIGNED_VERSIONS.
    pub signed_versions: Vec<SignedVersion>,
    /// Incremented on each signing attempt; stale MPC callbacks are ignored.
    pub attempts: u32,
    pub tx_hash: Option<String>,
    pub failure: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EthTxParams {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    /// keccak256 of the unsigned transaction, hex (what the MPC signed).
    pub payload_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignedVersion {
    pub eth_tx: EthTxParams,
    pub signature: EthSignature,
}

/// Secp256k1 signature as returned by the MPC contract (hex, no 0x).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EthSignature {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferState {
    Pending,
    /// NEAR transfer promise in flight.
    Sending,
    /// ETH: MPC sign request in flight.
    Signing,
    Signed,
    Broadcast,
    Confirmed,
    Failed,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanStatus {
    Active,
    Overdue,
    Proposed,
    Waiting,
    Eligible,
    Executing,
    Settled,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PlanView {
    pub plan: Plan,
    pub status: PlanStatus,
    /// When the plan becomes `Overdue` if the owner does not check in.
    pub overdue_at_ms: u64,
    pub now_ms: u64,
}
