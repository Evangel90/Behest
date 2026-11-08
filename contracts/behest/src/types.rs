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
    /// Gas limit of every ETH transfer in this proposal, fixed when the fee
    /// reserve is computed so the reserve always covers what gets signed.
    pub eth_gas_limit: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asset {
    Near,
    Eth,
    /// Allowlisted ERC-20 on the ETH chain, by lowercase `0x` token address.
    /// Appended last so stored plans keep their borsh encoding.
    Erc20(String),
    /// Allowlisted NEP-141 token on NEAR, held in this contract's escrow.
    Nep141(AccountId),
}

impl Asset {
    /// Paid from the plan's Ethereum vault through Chain Signatures.
    pub fn is_evm(&self) -> bool {
        matches!(self, Asset::Eth | Asset::Erc20(_))
    }
}

/// Admin-allowlisted token. Only tokens that revert on a failed `transfer`
/// (rather than returning false) belong here: the executor treats a successful
/// receipt as a completed transfer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Erc20Token {
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
}

/// Someone who can receive in place of a heir (a named alternate or the plan's
/// fallback). Destinations are per chain, as for heirs.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Recipient {
    pub account_id: AccountId,
    pub near_destination: Option<AccountId>,
    pub eth_destination: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FixedAmount {
    pub heir: AccountId,
    pub asset: Asset,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Alternate {
    pub heir: AccountId,
    pub recipient: Recipient,
}

/// Optional per-plan release rules (D17), stored beside the plan.
///  * `fixed`: paid first, in order, each capped by what is left of that asset;
///    the rest is split by `share_bps`.
///  * `remainder_to`: the heir who receives the rounding remainder of every
///    asset (otherwise it stays undistributed, D12).
///  * Unclaimed shares: a transfer still `Pending` `claim_window_ms` after the
///    plan became claimable can be reassigned by anyone to that heir's
///    alternate, and one window later to the plan's `fallback`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ReleaseRules {
    pub fixed: Vec<FixedAmount>,
    pub remainder_to: Option<AccountId>,
    pub alternates: Vec<Alternate>,
    pub fallback: Option<Recipient>,
    pub claim_window_ms: u64,
}

/// How transfers start once a plan is claimable (D19). Heirs can always claim
/// themselves; `Automatic` lets anyone (in practice the executor) start them
/// at once, `Hybrid` only after `hybrid_grace_ms`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum ReleaseMode {
    #[default]
    Claim,
    Automatic,
    Hybrid,
}

/// Optional per-plan release options (D18, D19), stored beside the plan.
/// Delay signers can only extend an approved release's waiting period, by at
/// most `max_extension_ms` per extension and `max_total_extension_ms` overall.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ReleaseOptions {
    pub mode: ReleaseMode,
    pub hybrid_grace_ms: u64,
    pub delay_signers: Vec<AccountId>,
    pub delay_quorum: u8,
    pub max_extension_ms: u64,
    pub max_total_extension_ms: u64,
    /// Per-heir and/or per-asset-group modes; the first match wins, otherwise
    /// `mode`. Appended last; options stored before it existed still decode.
    #[serde(default)]
    pub overrides: Vec<ModeOverride>,
}

/// Options as first stored (before `overrides`); read as a fallback.
#[near(serializers = [borsh])]
pub struct ReleaseOptionsV1 {
    pub mode: ReleaseMode,
    pub hybrid_grace_ms: u64,
    pub delay_signers: Vec<AccountId>,
    pub delay_quorum: u8,
    pub max_extension_ms: u64,
    pub max_total_extension_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AssetGroup {
    All,
    /// NEAR and NEP-141 tokens.
    Near,
    /// ETH and ERC-20 tokens from the vault.
    Ethereum,
}

impl AssetGroup {
    pub fn contains(&self, a: &Asset) -> bool {
        match self {
            AssetGroup::All => true,
            AssetGroup::Near => !a.is_evm(),
            AssetGroup::Ethereum => a.is_evm(),
        }
    }
}

/// Release mode for one heir (or every heir, `heir: None`) and asset group.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ModeOverride {
    pub heir: Option<AccountId>,
    pub assets: AssetGroup,
    pub mode: ReleaseMode,
    pub hybrid_grace_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingExtension {
    pub extension_ms: u64,
    pub reason: Option<String>,
    pub votes: Vec<AccountId>,
}

/// Extensions of the current proposal's waiting period.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionState {
    pub proposal_id: u64,
    pub total_ms: u64,
    pub count: u32,
    pub pending: Option<PendingExtension>,
}

/// Admin-allowlisted NEP-141 token. `storage_deposit` is what registering one
/// account with it costs (its NEP-145 `storage_balance_bounds().min`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Nep141Token {
    pub account_id: AccountId,
    pub symbol: String,
    pub decimals: u8,
    pub storage_deposit: U128,
}

/// Token balance of a plan's vault as observed by the proposer (like `eth_balance`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenBalance {
    pub token: String,
    pub amount: U128,
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
    pub gas_limit: u64,
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
    /// NEP-141 balances held for this plan (allowlisted tokens only).
    pub ft_escrow: Vec<TokenBalance>,
}
