//! Behest contract: MVP plan lifecycle.
//!
//! Spec: docs/stage0. Each public method notes its transition id from
//! 01-state-machine.md (P1..P10, T1..T6).

mod errors;
pub mod btc;
pub mod eth;
pub mod ethproof;
mod legacy;
mod policy;
mod types;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, ext_contract, log, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub use errors::Error;
use errors::fail;
pub use types::*;

const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Conservative storage cost per byte (10^19 yocto = 0.00001 NEAR).
const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// Default gas limit for vault transfers. A transfer to an address that has
/// never been used costs far more than 21 000 gas since Sepolia's Glamsterdam
/// upgrade (≈207k observed); unused gas is not charged.
pub const DEFAULT_ETH_GAS_LIMIT: u64 = 250_000;
const MIN_ETH_GAS_LIMIT: u64 = 15_000;
const MAX_ETH_GAS_LIMIT: u64 = 2_000_000;
/// MPC `sign` requires 15 Tgas attached on testnet (config v3.18); keep headroom.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
const MPC_DOMAIN_SECP256K1: u32 = 0;
const MAX_MPC_RESPONSE_BYTES: usize = 1024;
/// Fee bumps stop at the cap, so distinct versions are few; the oldest is dropped beyond this.
const MAX_SIGNED_VERSIONS: usize = 32;
/// The ERC-20 allowlist lives under its own storage key rather than in the
/// contract struct, so adding it needed no state migration.
const ERC20_TOKENS_KEY: &[u8] = b"erc20_tokens";
const MAX_ERC20_TOKENS: usize = 4;
/// Transfer index that addresses the owner's vault withdrawal (D7) instead of
/// a proposal transfer, so executors and views use the same methods for both.
pub const VAULT_WITHDRAWAL: u32 = u32::MAX;
/// One withdrawal record per owner (`vw:<owner>`), plus the owners whose
/// withdrawal is unresolved (for executors). Raw keys: no state migration.
const WITHDRAWAL_PREFIX: &[u8] = b"vw:";
const PENDING_WITHDRAWALS_KEY: &[u8] = b"vw_pending";
/// NEP-141 allowlist, per-plan token escrow (`ft:<token>:<owner>`) and the
/// NEAR reserved for registering heirs with tokens (`ftr:<owner>`), all under
/// raw keys. Account IDs can't contain ':', so the keys can't collide.
const NEP141_TOKENS_KEY: &[u8] = b"nep141_tokens";
const MAX_NEP141_TOKENS: usize = 4;
const FT_GAS: Gas = Gas::from_tgas(15);
/// Bitcoin (D20). Each input needs its own MPC signature, so a payout spends
/// at most this many coins (gas). State lives under raw keys: `btc_config`,
/// `btcd:` destinations, `btcpk:` vault key, `btcp:` release, `btx:` txs.
const MAX_BTC_INPUTS: usize = 2;
const BTC_CONFIG_KEY: &[u8] = b"btc_config";
/// D22: the Ethereum light client on NEAR (`block_hash_safe`), and per
/// transfer the hash of a transaction proven to have reverted (`rvp:`).
const ETH_LIGHT_CLIENT_KEY: &[u8] = b"eth_light_client";
const LIGHT_CLIENT_GAS: Gas = Gas::from_tgas(10);
const PROOF_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MAX_PROOF_NODES: usize = 16;

/// MPC `sign` arguments (docs/stage0/03-signing-boundary.md).
#[near(serializers = [json])]
pub struct SignRequestArgs {
    pub payload_v2: SignPayload,
    pub path: String,
    pub domain_id: u32,
}

#[near(serializers = [json])]
pub enum SignPayload {
    Ecdsa(String),
}

/// MPC response: `{"scheme":"Secp256k1","big_r":{"affine_point":".."},"s":{"scalar":".."},"recovery_id":0}`.
#[near(serializers = [json])]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 { big_r: AffinePoint, s: Scalar, recovery_id: u8 },
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

#[allow(dead_code)]
#[ext_contract(mpc)]
trait Mpc {
    fn sign(&mut self, request: SignRequestArgs);
    fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u32>) -> String;
}

/// Derivation path of a plan's Bitcoin vault key (D20); predecessor: this contract.
pub fn btc_vault_path(owner: &AccountId) -> String {
    format!("behest/v1/{owner}/btc")
}

/// Derivation path of a plan's Sepolia vault; the predecessor is this contract.
pub fn eth_vault_path(owner: &AccountId) -> String {
    format!("behest/v1/{owner}/eth")
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    /// v0.1 plan layout; read and converted lazily (see legacy.rs).
    Plans,
    Executors,
    OpenReleases,
    PlansV2,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    admin: AccountId,
    mpc_contract: AccountId,
    eth_chain_id: u64,
    /// Upper bound on `max_fee_per_gas` for any vault transaction (wei).
    eth_max_fee_cap: U128,
    /// Starting fees for a first signing attempt (clamped to the cap).
    eth_initial_max_fee: U128,
    eth_priority_fee: U128,
    paused: bool,
    executors: IterableSet<AccountId>,
    /// Owners with a proposal that is not yet settled (for executors and UIs).
    open_releases: IterableSet<AccountId>,
    plans: LookupMap<AccountId, Plan>,
    legacy_plans: LookupMap<AccountId, legacy::PlanV1>,
    /// Gas limit snapshotted into each new proposal.
    eth_gas_limit: u64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub admin: AccountId,
    pub mpc_contract: AccountId,
    pub eth_chain_id: u64,
    pub eth_max_fee_cap: U128,
    pub eth_initial_max_fee: U128,
    pub eth_priority_fee: U128,
    pub eth_gas_limit: u64,
    pub erc20_tokens: Vec<Erc20Token>,
    pub nep141_tokens: Vec<Nep141Token>,
    pub btc: BtcConfig,
    pub eth_light_client: Option<AccountId>,
    pub paused: bool,
    pub executors: Vec<AccountId>,
    pub demo_timers: bool,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard": "behest", "version": "1.0.0", "event": event, "data": [data]})
    );
}

fn now() -> u64 {
    env::block_timestamp_ms()
}

fn caller() -> AccountId {
    env::predecessor_account_id()
}

#[near]
impl Contract {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admin: AccountId,
        mpc_contract: AccountId,
        eth_chain_id: u64,
        eth_max_fee_cap: U128,
        eth_initial_max_fee: U128,
        eth_priority_fee: U128,
        eth_gas_limit: Option<u64>,
    ) -> Self {
        let eth_gas_limit = eth_gas_limit.unwrap_or(DEFAULT_ETH_GAS_LIMIT);
        assert_gas_limit(eth_gas_limit);
        Self {
            admin,
            mpc_contract,
            eth_chain_id,
            eth_max_fee_cap,
            eth_initial_max_fee,
            eth_priority_fee,
            paused: false,
            executors: IterableSet::new(StorageKey::Executors),
            open_releases: IterableSet::new(StorageKey::OpenReleases),
            plans: LookupMap::new(StorageKey::PlansV2),
            legacy_plans: LookupMap::new(StorageKey::Plans),
            eth_gas_limit,
        }
    }

    /// Upgrade from the v0.1 layout. Config, executors and open releases carry
    /// over; plans move to the new layout one by one as they are next touched.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(eth_gas_limit: u64) -> Self {
        assert_gas_limit(eth_gas_limit);
        let old: legacy::ContractV1 = env::state_read().unwrap_or_else(|| env::panic_str("no v0.1 state"));
        Self {
            admin: old.admin,
            mpc_contract: old.mpc_contract,
            eth_chain_id: old.eth_chain_id,
            eth_max_fee_cap: old.eth_max_fee_cap,
            eth_initial_max_fee: old.eth_initial_max_fee,
            eth_priority_fee: old.eth_priority_fee,
            paused: old.paused,
            executors: old.executors,
            open_releases: old.open_releases,
            plans: LookupMap::new(StorageKey::PlansV2),
            legacy_plans: old.plans,
            eth_gas_limit,
        }
    }

    // ---------------------------------------------------------------- owner

    /// P1 create / P2 replace. Attach enough NEAR to cover storage growth;
    /// the excess is refunded. Replacing counts as a check-in.
    #[payable]
    pub fn set_plan(&mut self, plan: PlanInput) {
        let owner = caller();
        let policy = policy::validate(&owner, plan);
        // Existing release rules and options must still fit the new heirs and guardians.
        if let Some(r) = read_rules(&owner) {
            policy::validate_rules(&owner, &policy, r, |a| btc_dest(&owner, a).is_some());
        }
        if let Some(o) = read_options(&owner) {
            policy::validate_options(&owner, &policy, o);
        }
        self.migrate_plan(&owner);
        if self.plans.contains_key(&owner) {
            self.archive_settled(&owner);
        }
        let storage_before = env::storage_usage();
        // A new plan version restates the owner's wishes: fixed amounts count afresh.
        env::storage_remove(&fixed_paid_key(&owner));

        let version = match self.plans.get_mut(&owner) {
            Some(existing) => {
                if existing.proposal.is_some() {
                    fail(Error::ProposalOpen);
                }
                existing.policy = policy;
                existing.version += 1;
                existing.last_check_in_ms = now();
                existing.version
            }
            None => {
                if self.paused {
                    fail(Error::Paused);
                }
                self.plans.insert(
                    owner.clone(),
                    Plan {
                        owner: owner.clone(),
                        version: 1,
                        policy,
                        last_check_in_ms: now(),
                        escrow: U128(0),
                        eth_next_nonce: 0,
                        proposal: None,
                        proposals_opened: 0,
                    },
                );
                1
            }
        };
        self.plans.flush();
        self.charge_storage(storage_before, &owner);
        emit("plan_set", near_sdk::serde_json::json!({"owner": owner, "version": version}));
    }

    /// P3. During `Proposed`/`Waiting` this also cancels the proposal (P7).
    pub fn check_in(&mut self) {
        let owner = caller();
        self.archive_settled(&owner);
        let had_proposal = self.plan_ref(&owner).proposal.is_some();
        if had_proposal {
            self.cancel_inner(&owner);
        }
        let plan = self.plan_mut(&owner);
        plan.last_check_in_ms = now();
        emit("check_in", near_sdk::serde_json::json!({"owner": owner, "at_ms": now()}));
    }

    /// P7. Owner cancels an open proposal before `waiting_ends_at`.
    pub fn cancel_release(&mut self) {
        let owner = caller();
        self.cancel_inner(&owner);
        self.plan_mut(&owner).last_check_in_ms = now();
    }

    /// P10. Anyone may add NEAR to a plan's escrow while no proposal is open.
    #[payable]
    pub fn deposit(&mut self, owner: AccountId) {
        let amount = env::attached_deposit().as_yoctonear();
        self.archive_settled(&owner);
        let plan = self.plan_mut(&owner);
        if plan.proposal.is_some() {
            fail(Error::ProposalOpen);
        }
        plan.escrow = U128(plan.escrow.0 + amount);
        emit("deposit", near_sdk::serde_json::json!({"owner": owner, "amount": U128(amount)}));
    }

    /// P9. Owner withdraws NEAR from escrow while no proposal is open.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let owner = caller();
        let plan = self.plan_mut(&owner);
        if release_open(plan) {
            fail(Error::ProposalOpen);
        }
        if amount.0 > plan.escrow.0 {
            fail(Error::InsufficientEscrow);
        }
        plan.escrow = U128(plan.escrow.0 - amount.0);
        emit("withdraw", near_sdk::serde_json::json!({"owner": owner, "amount": amount}));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// D17. The owner sets (or with `None` clears) the plan's release rules.
    /// Frozen while a release is open, so guardians approve what is applied.
    #[payable]
    pub fn set_release_rules(&mut self, rules: Option<ReleaseRules>) {
        let owner = caller();
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        let storage_before = env::storage_usage();
        env::storage_remove(&fixed_paid_key(&owner));
        match rules {
            Some(r) => {
                let r = policy::validate_rules(&owner, &plan.policy, r, |a| btc_dest(&owner, a).is_some());
                env::storage_write(&rules_key(&owner), &near_sdk::borsh::to_vec(&r).expect("borsh"));
                emit("release_rules_set", near_sdk::serde_json::json!({"owner": owner, "rules": r}));
            }
            None => {
                env::storage_remove(&rules_key(&owner));
                emit("release_rules_cleared", near_sdk::serde_json::json!({"owner": owner}));
            }
        }
        self.charge_storage(storage_before, &owner);
    }

    /// D18/D19. The owner sets (or clears) release mode and delay signers.
    #[payable]
    pub fn set_release_options(&mut self, options: Option<ReleaseOptions>) {
        let owner = caller();
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        let storage_before = env::storage_usage();
        match options {
            Some(o) => {
                let o = policy::validate_options(&owner, &plan.policy, o);
                env::storage_write(&options_key(&owner), &near_sdk::borsh::to_vec(&o).expect("borsh"));
                emit("release_options_set", near_sdk::serde_json::json!({"owner": owner, "options": o}));
            }
            None => {
                env::storage_remove(&options_key(&owner));
                emit("release_options_cleared", near_sdk::serde_json::json!({"owner": owner}));
            }
        }
        self.charge_storage(storage_before, &owner);
    }

    pub fn get_release_options(&self, owner: AccountId) -> Option<ReleaseOptions> {
        read_options(&owner)
    }

    pub fn get_release_rules(&self, owner: AccountId) -> Option<ReleaseRules> {
        read_rules(&owner)
    }

    /// D17. Anyone may move a share nobody claimed in time: still `Pending`
    /// one claim window after the plan became claimable, a heir's transfer
    /// goes to their alternate (or the fallback if none can receive this
    /// asset); one more window later, an alternate's goes to the fallback.
    /// Never-signed transfers only, so no ETH nonce or signature exists yet.
    pub fn reassign_unclaimed(&mut self, owner: AccountId, index: u32) {
        if self.paused {
            fail(Error::Paused);
        }
        let rules = read_rules(&owner).unwrap_or_default();
        let t = now();
        let plan = self.plan_mut(&owner);
        let is_heir = |a: &AccountId| plan.policy.heirs.iter().any(|h| &h.account_id == a);
        let p = plan.proposal.as_ref().unwrap_or_else(|| fail(Error::NotEligible));
        let start = match p.waiting_ends_at_ms {
            Some(end) if t >= end => end,
            _ => fail(Error::NotEligible),
        };
        let tr = p.transfers.get(index as usize).unwrap_or_else(|| fail(Error::BadIndex));
        if tr.state != TransferState::Pending {
            fail(Error::NotReassignable);
        }
        let receives = |r: &&Recipient| dest_for(&owner, r, &tr.asset).is_some();
        let fallback = rules.fallback.as_ref().filter(receives);
        let (stage, next) = if is_heir(&tr.heir) {
            (1, rules.alternates.iter().find(|a| a.heir == tr.heir).map(|a| &a.recipient).filter(receives).or(fallback))
        } else if rules.alternates.iter().any(|a| a.recipient.account_id == tr.heir) {
            (2, fallback)
        } else {
            fail(Error::NotReassignable)
        };
        let next = next.unwrap_or_else(|| fail(Error::NotReassignable)).clone();
        if t < start + stage * rules.claim_window_ms {
            fail(Error::NotReassignable);
        }
        let dest = dest_for(&owner, &next, &tr.asset).expect("filtered");
        let from = tr.heir.clone();
        let tr = self.transfer_mut(&owner, index);
        tr.heir = next.account_id.clone();
        tr.destination = dest;
        emit("transfer_reassigned", near_sdk::serde_json::json!({"owner": owner, "index": index, "from": from, "to": next.account_id}));
    }

    /// NEP-141 deposit hook (`ft_transfer_call` to this contract). `msg` is the
    /// plan owner the tokens are for (empty: the sender's own plan). Anything
    /// not accepted is returned to the sender by the token (NEP-141 refund):
    /// unlisted tokens, unknown plans, and plans with a release open (like
    /// `deposit`, later deposits are not distributed).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = caller();
        if !nep141_tokens().iter().any(|t| t.account_id == token) {
            return PromiseOrValue::Value(amount);
        }
        let owner = if msg.trim().is_empty() {
            sender_id.clone()
        } else {
            match msg.trim().parse::<AccountId>() {
                Ok(a) => a,
                Err(_) => return PromiseOrValue::Value(amount),
            }
        };
        if self.read_plan(&owner).is_none() {
            return PromiseOrValue::Value(amount);
        }
        self.archive_settled(&owner);
        if self.read_plan(&owner).is_some_and(|p| p.proposal.is_some()) {
            return PromiseOrValue::Value(amount);
        }
        set_ft_escrow(&token, &owner, ft_escrow(&token, &owner) + amount.0);
        emit("ft_deposit", near_sdk::serde_json::json!({"owner": owner, "token": token, "sender": sender_id, "amount": amount}));
        PromiseOrValue::Value(U128(0))
    }

    /// The owner takes NEP-141 tokens back out of escrow (no release open).
    pub fn withdraw_ft(&mut self, token: AccountId, amount: U128) -> Promise {
        let owner = caller();
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        let held = ft_escrow(&token, &owner);
        if amount.0 == 0 || amount.0 > held {
            fail(Error::InsufficientTokenEscrow);
        }
        set_ft_escrow(&token, &owner, held - amount.0);
        emit("ft_withdraw", near_sdk::serde_json::json!({"owner": owner, "token": token, "amount": amount}));
        ft_transfer(&token, &owner, amount.0, "Behest withdrawal").then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_ft_withdraw(owner, token, amount),
        )
    }

    /// Restores the escrow if the withdrawal transfer failed.
    #[private]
    pub fn on_ft_withdraw(&mut self, owner: AccountId, token: AccountId, amount: U128) {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 0).is_ok();
        if !ok {
            set_ft_escrow(&token, &owner, ft_escrow(&token, &owner) + amount.0);
            emit("ft_withdraw_failed", near_sdk::serde_json::json!({"owner": owner, "token": token, "amount": amount}));
        }
    }

    /// D7. The owner withdraws ETH or a token from the plan's Sepolia vault to
    /// `to`. Only while no release is open (or after it settled), so heirs'
    /// snapshots never change. Takes the next vault nonce like any transfer and
    /// goes through the same executor path; addressed as VAULT_WITHDRAWAL.
    /// Fees come from the vault's ETH, so withdraw ETH net of one transfer fee.
    pub fn withdraw_vault(&mut self, asset: Asset, amount: U128, to: String) -> Promise {
        let owner = caller();
        if self.paused {
            fail(Error::Paused);
        }
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        let asset = match asset {
            Asset::Near | Asset::Nep141(_) | Asset::Btc => fail(Error::BadAsset),
            Asset::Eth => Asset::Eth,
            Asset::Erc20(token) => {
                let token = token.to_ascii_lowercase();
                if eth::parse_address(&token).is_none() {
                    fail(Error::InvalidEthAddress);
                }
                Asset::Erc20(token)
            }
        };
        let to = to.to_ascii_lowercase();
        if eth::parse_address(&to).is_none() {
            fail(Error::InvalidEthAddress);
        }
        if amount.0 == 0 {
            fail(Error::NothingToDistribute);
        }
        if withdrawal_busy(&read_withdrawal(&owner)) {
            fail(Error::VaultBusy);
        }
        write_withdrawal(&owner, &new_transfer(&owner, asset.clone(), to.clone(), amount.0));
        emit("vault_withdrawal", near_sdk::serde_json::json!({"owner": owner, "asset": asset, "amount": amount, "to": to}));
        self.sign_eth(&owner, VAULT_WITHDRAWAL as usize)
    }

    /// Resolves a withdrawal that failed without being mined: re-signs its
    /// nonce as a 0-ETH transfer to the same destination, so later vault nonces
    /// (heir transfers) are never blocked. Same nonce, so at most one of the
    /// versions can land. The owner or an executor may call it.
    pub fn cancel_vault_withdrawal(&mut self, owner: AccountId) -> PromiseOrValue<()> {
        let who = caller();
        if who != owner && !self.executors.contains(&who) {
            fail(Error::Unauthorized);
        }
        let mut w = read_withdrawal(&owner).unwrap_or_else(|| fail(Error::NoWithdrawal));
        // Only before any broadcast was reported: versions are rebuilt from the
        // record's current asset and amount, so it must not hold a sent original.
        if w.state != TransferState::Failed || w.failure.as_deref() == Some("Reverted") || w.tx_hash.is_some() {
            fail(Error::InvalidTransferState);
        }
        // Bitcoin has no nonce to fill: a never-broadcast withdrawal is simply
        // closed. (If its inputs were real, broadcasting it later only pays the
        // owner's own address.)
        if w.asset.is_btc() {
            // A replaced version may still be mined: then it isn't cancellable.
            if !read_btx_versions(&owner, VAULT_WITHDRAWAL, None).is_empty() {
                fail(Error::InvalidTransferState);
            }
            w.failure = Some("Cancelled".into());
            write_withdrawal(&owner, &w);
            emit("vault_withdrawal_cancelled", near_sdk::serde_json::json!({"owner": owner, "asset": "Btc"}));
            return PromiseOrValue::Value(());
        }
        w.asset = Asset::Eth;
        w.amount = U128(0);
        w.signed_versions.clear();
        write_withdrawal(&owner, &w);
        emit("vault_withdrawal_cancelled", near_sdk::serde_json::json!({"owner": owner, "nonce": w.eth_tx.as_ref().map(|t| t.nonce)}));
        PromiseOrValue::Promise(self.sign_eth(&owner, VAULT_WITHDRAWAL as usize))
    }

    // -------------------------------------------------------------- bitcoin

    /// D20. Looks up the plan's Bitcoin vault key from the MPC contract (once)
    /// and stores it: the contract needs the key hash to build the sighashes.
    /// Anyone may call it; the key is whatever MPC derives for this contract.
    pub fn register_btc_vault(&mut self, owner: AccountId) -> Promise {
        self.plan_ref(&owner);
        if btc_pubkey(&owner).is_some() {
            fail(Error::InvalidTransferState);
        }
        mpc::ext(self.mpc_contract.clone())
            .with_static_gas(Gas::from_tgas(10))
            .derived_public_key(btc_vault_path(&owner), Some(env::current_account_id()), Some(MPC_DOMAIN_SECP256K1))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_btc_vault_key(owner))
    }

    #[private]
    pub fn on_btc_vault_key(&mut self, owner: AccountId) -> bool {
        let key = env::promise_result_checked(0, 512).ok().and_then(|b| near_sdk::serde_json::from_slice::<String>(&b).ok());
        let pk = key
            .as_deref()
            .and_then(|k| k.strip_prefix("secp256k1:"))
            .and_then(base58_decode)
            .and_then(|xy| btc::compress(&xy));
        match pk {
            Some(pk) => {
                env::storage_write(&btc_pubkey_key(&owner), &pk);
                emit("btc_vault_registered", near_sdk::serde_json::json!({"owner": owner, "address": btc::p2wpkh_address(&btc::hash160(&pk))}));
                true
            }
            None => false,
        }
    }

    pub fn get_btc_vault(&self, owner: AccountId) -> Option<BtcVaultView> {
        let pk = btc_pubkey(&owner)?;
        Some(BtcVaultView { path: btc_vault_path(&owner), pubkey: eth::hex_encode(&pk), address: btc::p2wpkh_address(&btc::hash160(&pk)) })
    }

    /// The owner sets Bitcoin destinations for heirs and for named alternates
    /// or the fallback (testnet SegWit addresses). Frozen while a release is open.
    #[payable]
    pub fn set_btc_destinations(&mut self, destinations: Vec<BtcDestination>) {
        let owner = caller();
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        let rules = read_rules(&owner).unwrap_or_default();
        let known = |a: &AccountId| {
            plan.policy.heirs.iter().any(|h| &h.account_id == a)
                || rules.alternates.iter().any(|x| &x.recipient.account_id == a)
                || rules.fallback.as_ref().is_some_and(|f| &f.account_id == a)
        };
        if destinations.len() > policy::MAX_HEIRS * 2 + 1 {
            fail(Error::InvalidHeirs);
        }
        for (i, d) in destinations.iter().enumerate() {
            if btc::address_script(&d.address).is_none() {
                fail(Error::InvalidBtcAddress);
            }
            if !known(&d.account_id) || destinations[..i].iter().any(|x| x.account_id == d.account_id) {
                fail(Error::InvalidHeirs);
            }
        }
        let before = env::storage_usage();
        env::storage_write(&btc_dests_key(&owner), &near_sdk::borsh::to_vec(&destinations).expect("borsh"));
        emit("btc_destinations_set", near_sdk::serde_json::json!({"owner": owner, "destinations": destinations}));
        self.charge_storage(before, &owner);
    }

    pub fn get_btc_destinations(&self, owner: AccountId) -> Vec<BtcDestination> {
        btc_dests(&owner)
    }

    pub fn set_btc_config(&mut self, config: BtcConfig) {
        self.assert_admin();
        if config.fee_rate == 0 || config.fee_rate > config.max_fee_rate || config.max_fee_rate > 1_000 {
            fail(Error::InvalidOptions);
        }
        env::storage_write(BTC_CONFIG_KEY, &near_sdk::borsh::to_vec(&config).expect("borsh"));
        emit("btc_config_set", near_sdk::serde_json::json!({"config": config}));
    }

    /// The Bitcoin transaction of transfer `index` (or the owner's withdrawal).
    pub fn get_btc_tx(&self, owner: AccountId, index: u32) -> Option<BtcTx> {
        let pid = if index == VAULT_WITHDRAWAL { None } else { Some(self.read_plan(&owner)?.proposal?.id) };
        read_btx(&owner, index, pid)
    }

    /// Earlier signed versions of a Bitcoin payout replaced by a fee bump.
    pub fn get_btc_tx_versions(&self, owner: AccountId, index: u32) -> Vec<BtcTx> {
        let pid = if index == VAULT_WITHDRAWAL { None } else { self.read_plan(&owner).and_then(|p| p.proposal).map(|p| p.id) };
        if index != VAULT_WITHDRAWAL && pid.is_none() {
            return vec![];
        }
        read_btx_versions(&owner, index, pid)
    }

    /// D21. Settled releases moved off the plan, oldest first (at most MAX_HISTORY).
    pub fn get_release_history(&self, owner: AccountId) -> Vec<Proposal> {
        let mut h = read_history(&owner);
        // a settled release not yet archived is history too
        if let Some(p) = self.read_plan(&owner).and_then(|p| p.proposal) {
            if p.waiting_ends_at_ms.is_some() && p.transfers.iter().all(|t| t.state == TransferState::Confirmed) {
                h.push(p);
            }
        }
        h
    }

    /// D21. Balances the open proposal was built from: NEAR and NEP-141 as
    /// counted by the contract, ETH, ERC-20 and BTC as reported by the proposer.
    pub fn get_release_snapshot(&self, owner: AccountId) -> Vec<(Asset, U128)> {
        if self.read_plan(&owner).and_then(|p| p.proposal).is_none() {
            return vec![];
        }
        env::storage_read(&snapshot_key(&owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
    }

    /// D21. Fixed amounts already paid by earlier rounds, per heir and asset.
    pub fn get_fixed_paid(&self, owner: AccountId) -> Vec<FixedAmount> {
        read_fixed_paid(&owner)
    }

    pub fn get_btc_release(&self, owner: AccountId) -> Option<BtcRelease> {
        let id = self.read_plan(&owner)?.proposal?.id;
        read_btc_release(&owner).filter(|r| r.proposal_id == id)
    }

    /// D20, like topping up the ETH vault after an over-report: a guardian
    /// replaces the reported coins the next payouts spend, while nothing has
    /// reached the Bitcoin network. Every new payout then conflicts with any
    /// earlier signed one (the new set must reuse one of the old coins, unless
    /// nothing was signed), so no heir can be paid twice. Amounts don't change.
    pub fn rebase_btc(&mut self, owner: AccountId, utxos: Vec<BtcUtxo>) {
        let g = caller();
        let mut rel = read_btc_release(&owner).unwrap_or_else(|| fail(Error::NoProposal));
        let plan = self.plan_ref(&owner);
        if !plan.policy.guardians.contains(&g) {
            fail(Error::NotGuardian);
        }
        let p = plan.proposal.as_ref().filter(|p| p.id == rel.proposal_id).unwrap_or_else(|| fail(Error::NoProposal));
        let btc_idx: Vec<usize> = p.transfers.iter().enumerate().filter(|(_, t)| t.asset.is_btc()).map(|(i, _)| i).collect();
        if btc_idx.iter().any(|i| matches!(p.transfers[*i].state, TransferState::Signing | TransferState::Broadcast | TransferState::Confirmed)) {
            fail(Error::InvalidTransferState);
        }
        let (_, total) = check_utxos(&utxos);
        let shares: u64 = btc_idx.iter().map(|i| p.transfers[*i].amount.0 as u64).sum();
        if total < shares + rel.reserve.0 {
            fail(Error::InsufficientFeeReserve);
        }
        let same = |a: &BtcUtxo, b: &BtcUtxo| a.txid == b.txid && a.vout == b.vout;
        if rel.signed > 0 && !utxos.iter().any(|u| rel.snapshot.iter().any(|o| same(o, u))) {
            fail(Error::InvalidUtxos);
        }
        let id = rel.proposal_id;
        rel.snapshot = utxos.clone();
        rel.head = utxos;
        rel.signed = 0;
        rel.last = None;
        write_btc_release(&owner, &rel);
        for i in btc_idx {
            remove_btx(&owner, i as u32, Some(id));
            let mut tr = self.tr_get(&owner, i as u32);
            tr.state = TransferState::Pending;
            tr.failure = None;
            tr.tx_hash = None;
            self.tr_put(&owner, i as u32, tr);
        }
        emit("btc_rebased", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id, "by": g}));
    }

    /// D20/D7 for Bitcoin: the owner spends reported vault coins to `to`
    /// (change back to the vault), only with no release open.
    pub fn withdraw_btc(&mut self, utxos: Vec<BtcUtxo>, amount: U64, to: String) -> Promise {
        let owner = caller();
        if self.paused {
            fail(Error::Paused);
        }
        let plan = self.plan_ref(&owner);
        if release_open(&plan) {
            fail(Error::ProposalOpen);
        }
        if btc_pubkey(&owner).is_none() {
            fail(Error::BtcVaultUnknown);
        }
        if btc::address_script(&to).is_none() {
            fail(Error::InvalidBtcAddress);
        }
        let (_, total) = check_utxos(&utxos);
        if amount.0 < btc::DUST || amount.0 >= total {
            fail(Error::NothingToDistribute);
        }
        if withdrawal_busy(&read_withdrawal(&owner)) {
            fail(Error::VaultBusy);
        }
        write_withdrawal(&owner, &new_transfer(&owner, Asset::Btc, to.clone(), amount.0 as u128));
        remove_btx(&owner, VAULT_WITHDRAWAL, None);
        write_btx(&owner, VAULT_WITHDRAWAL, None, &BtcTx { inputs: utxos, outputs: vec![], fee_rate: 0, fee: U64(0), seq: 0, txid: String::new(), sighashes: vec![], signatures: vec![], raw: None });
        emit("vault_withdrawal", near_sdk::serde_json::json!({"owner": owner, "asset": "Btc", "amount": amount, "to": to}));
        self.sign_btc(&owner, VAULT_WITHDRAWAL as usize)
    }

    #[private]
    pub fn on_btc_signed(&mut self, owner: AccountId, index: u32, attempt: u32) {
        let n = env::promise_results_count();
        let sigs: Option<Vec<BtcSig>> = (0..n)
            .map(|i| {
                env::promise_result_checked(i, MAX_MPC_RESPONSE_BYTES)
                    .ok()
                    .and_then(|b| near_sdk::serde_json::from_slice::<SignatureResponse>(&b).ok())
                    .and_then(|r| match r {
                        SignatureResponse::Secp256k1 { big_r, s, .. } if big_r.affine_point.len() == 66 && s.scalar.len() == 64 => {
                            Some(BtcSig { big_r: big_r.affine_point.to_ascii_lowercase(), s: s.scalar.to_ascii_lowercase() })
                        }
                        _ => None,
                    })
            })
            .collect();
        let mut tr = self.tr_get(&owner, index);
        if tr.attempts != attempt || tr.state != TransferState::Signing {
            return;
        }
        let pid = self.btx_pid(&owner, index);
        let mut b = read_btx(&owner, index, pid).expect("signing implies a tx");
        let pubkey = btc_pubkey(&owner).expect("registered");
        match sigs.filter(|v| v.len() == b.inputs.len()) {
            Some(v) => {
                let der: Vec<Vec<u8>> = v
                    .iter()
                    .map(|x| {
                        let r: [u8; 32] = eth::hex_decode(&x.big_r[2..]).and_then(|r| r.try_into().ok()).expect("checked");
                        let s: [u8; 32] = eth::hex_decode(&x.s).and_then(|r| r.try_into().ok()).expect("checked");
                        btc::der_sig(&r, &s)
                    })
                    .collect();
                b.raw = Some(eth::hex_encode(&to_tx(&b).signed(&pubkey, &der)));
                b.signatures = v;
                tr.state = TransferState::Signed;
            }
            None => {
                tr.state = TransferState::Failed;
                tr.failure = Some("SignFailed".into());
            }
        }
        write_btx(&owner, index, pid, &b);
        let state = tr.state;
        self.tr_put(&owner, index, tr);
        emit_transfer(&owner, index, state);
    }

    // ------------------------------------------------------------- guardian

    /// P4. A guardian opens a release once the owner is overdue.
    /// `eth_balance` and `erc20_balances` are the vault balances observed by
    /// the proposer (D5). Guardians approve the resulting transfer list.
    pub fn propose_release(&mut self, owner: AccountId, eth_balance: Option<U128>, erc20_balances: Option<Vec<TokenBalance>>, btc_utxos: Option<Vec<BtcUtxo>>) -> u64 {
        let g = caller();
        let fts = nep141_tokens();
        let allowed = erc20_tokens();
        let mut tokens: Vec<(String, u128)> = vec![];
        for b in erc20_balances.unwrap_or_default() {
            let token = b.token.to_ascii_lowercase();
            if !allowed.iter().any(|t| t.address == token) || tokens.iter().any(|(t, _)| *t == token) {
                fail(Error::UnknownToken);
            }
            if b.amount.0 > 0 {
                tokens.push((token, b.amount.0));
            }
        }
        let fee_cap = self.eth_max_fee_cap.0;
        let gas_limit = self.eth_gas_limit;
        let t = now();
        self.archive_settled(&owner);
        // D21: after a settled release the owner hasn't checked in since, a
        // follow-up round may distribute what is left; heirs can start it too
        // (they lose if a balance was under-reported). Guardians still approve.
        let is_guardian = self.plan_ref(&owner).policy.guardians.contains(&g);
        let follow_up = last_settled_at(&owner).is_some_and(|at| at > self.plan_ref(&owner).last_check_in_ms);
        let is_heir = self.plan_ref(&owner).policy.heirs.iter().any(|h| h.account_id == g);
        if !is_guardian && !(follow_up && is_heir) {
            fail(Error::NotGuardian);
        }
        let paid = read_fixed_paid(&owner);
        let plan = self.plan_mut(&owner);
        if plan.proposal.is_some() {
            fail(Error::ProposalExists);
        }
        if t < overdue_at(plan) {
            fail(Error::NotOverdue);
        }
        // The snapshot must see a quiet vault: an unresolved owner withdrawal
        // would change the balance and hold an earlier nonce. Executors resolve
        // it (confirm, retry or cancel_vault_withdrawal) without the owner.
        if withdrawal_busy(&read_withdrawal(&owner)) {
            fail(Error::VaultBusy);
        }

        // NEP-141: each token's escrow is split like NEAR among heirs with a
        // NEAR destination. Registering a heir with a token (NEP-145) costs
        // NEAR, reserved here from the plan's escrow so heirs need none.
        let rules = policy::rules_after_paid(&read_rules(&owner).unwrap_or_default(), &paid);
        let pol = plan.policy.clone();
        let near_ok = |i: usize| pol.heirs[i].near_destination.is_some();
        let eth_ok = |i: usize| pol.heirs[i].eth_destination.is_some();
        let btc_map = btc_dests(&owner);
        let btc_ok = |i: usize| btc_map.iter().any(|d| d.account_id == pol.heirs[i].account_id);
        // Bitcoin (D20): one payout per heir, chained through the vault's
        // change. The reserve covers each at the fee-rate cap: the first spends
        // the reported coins, the rest one change output each.
        let btc_utxos = btc_utxos.unwrap_or_default();
        let btc_utxos_reported = btc_utxos.clone();
        let btc_heirs = (0..pol.heirs.len()).filter(|i| btc_ok(*i)).count() as u64;
        let (btc_total, btc_reserve) = if btc_heirs > 0 && !btc_utxos.is_empty() {
            if btc_pubkey(&owner).is_none() {
                fail(Error::BtcVaultUnknown);
            }
            let (n, total) = check_utxos(&btc_utxos);
            let rate = btc_config().max_fee_rate;
            let reserve = (btc::vsize(n, &[34, 22]) + (btc_heirs - 1) * btc::vsize(1, &[34, 22])) * rate;
            if total <= reserve {
                fail(Error::InsufficientFeeReserve);
            }
            (total - reserve, reserve)
        } else {
            (0, 0)
        };
        let mut ft_snap: Vec<(AccountId, u128)> = vec![];
        let mut ft_reserve = 0u128;
        for t in &fts {
            let bal = ft_escrow(&t.account_id, &owner);
            if bal == 0 {
                continue;
            }
            let shares = policy::split(bal, &pol, &rules, &Asset::Nep141(t.account_id.clone()), near_ok);
            ft_reserve += shares.iter().filter(|a| **a > 0).count() as u128 * t.storage_deposit.0;
            ft_snap.push((t.account_id.clone(), bal));
        }
        if plan.escrow.0 < ft_reserve {
            fail(Error::InsufficientFeeReserve);
        }
        let near_total = plan.escrow.0 - ft_reserve;
        let eth_heirs = plan.policy.heirs.iter().filter(|h| h.eth_destination.is_some()).count() as u128;
        let eth_balance = eth_balance.map(|b| b.0).unwrap_or(0);
        // Every vault transaction (ETH or token) is paid from the vault's ETH,
        // so the reserve covers one max-fee transaction per transfer. Token
        // transfers are funded first; ETH is distributed only if what is left
        // also covers the ETH transfers themselves.
        let per_tx = gas_limit as u128 * fee_cap;
        let token_txs = if eth_heirs > 0 { eth_heirs * tokens.len() as u128 } else { 0 };
        let token_reserve = token_txs * per_tx;
        if eth_balance < token_reserve {
            fail(Error::InsufficientFeeReserve);
        }
        let after_tokens = eth_balance - token_reserve;
        let eth_reserve = eth_heirs * per_tx;
        let (eth_total, fee_reserve) = if eth_heirs > 0 && after_tokens > eth_reserve {
            (after_tokens - eth_reserve, token_reserve + eth_reserve)
        } else if eth_heirs > 0 && eth_balance > 0 && token_txs == 0 {
            fail(Error::InsufficientFeeReserve)
        } else {
            (0, token_reserve)
        };

        // One transfer per heir per asset: fixed amount + share (+ remainder).
        // Each split also yields its fixed part, recorded as paid once this round settles.
        let mut fixed_round: Vec<FixedAmount> = vec![];
        let mut split = |total: u128, asset: Asset, ok: &dyn Fn(usize) -> bool, dust: u128| -> Vec<u128> {
            let (out, fixed) = policy::split_detailed(total, &pol, &rules, &asset, ok);
            let out: Vec<u128> = out.into_iter().map(|a| if a < dust { 0 } else { a }).collect();
            for (i, f) in fixed.iter().enumerate() {
                let f = (*f).min(out[i]);
                if f > 0 {
                    fixed_round.push(FixedAmount { heir: pol.heirs[i].account_id.clone(), asset: asset.clone(), amount: U128(f) });
                }
            }
            out
        };
        let near_split = split(near_total, Asset::Near, &near_ok, 0);
        let ft_splits: Vec<Vec<u128>> = ft_snap.iter().map(|(t, b)| split(*b, Asset::Nep141(t.clone()), &near_ok, 0)).collect();
        let eth_split = split(eth_total, Asset::Eth, &eth_ok, 0);
        let erc_splits: Vec<Vec<u128>> = tokens.iter().map(|(t, b)| split(*b, Asset::Erc20(t.clone()), &eth_ok, 0)).collect();
        // Outputs below the dust limit aren't relayed: such a share stays in the vault.
        let btc_split = split(btc_total as u128, Asset::Btc, &btc_ok, btc::DUST as u128);
        let mut transfers = Vec::new();
        let near_reserved: u128 = near_split.iter().sum();
        for (i, h) in pol.heirs.iter().enumerate() {
            if let Some(dest) = &h.near_destination {
                if near_split[i] > 0 {
                    transfers.push(new_transfer(&h.account_id, Asset::Near, dest.to_string(), near_split[i]));
                }
                for ((token, _), sp) in ft_snap.iter().zip(&ft_splits) {
                    if sp[i] > 0 {
                        transfers.push(new_transfer(&h.account_id, Asset::Nep141(token.clone()), dest.to_string(), sp[i]));
                    }
                }
            }
            if let Some(dest) = &h.eth_destination {
                if eth_split[i] > 0 {
                    transfers.push(new_transfer(&h.account_id, Asset::Eth, dest.clone(), eth_split[i]));
                }
                for ((token, _), sp) in tokens.iter().zip(&erc_splits) {
                    if sp[i] > 0 {
                        transfers.push(new_transfer(&h.account_id, Asset::Erc20(token.clone()), dest.clone(), sp[i]));
                    }
                }
            }
            if btc_split[i] > 0 {
                let dest = btc_map.iter().find(|d| d.account_id == h.account_id).expect("btc_ok").address.clone();
                transfers.push(new_transfer(&h.account_id, Asset::Btc, dest, btc_split[i]));
            }
        }
        if transfers.is_empty() {
            fail(Error::NothingToDistribute);
        }

        plan.proposals_opened += 1;
        let id = plan.proposals_opened;
        plan.escrow = U128(near_total - near_reserved);
        for (token, bal) in &ft_snap {
            let reserved: u128 = transfers.iter().filter(|x| x.asset == Asset::Nep141(token.clone())).map(|x| x.amount.0).sum();
            set_ft_escrow(token, &owner, bal - reserved);
        }
        set_ft_reserve(&owner, ft_reserve);
        if transfers.iter().any(|x| x.asset.is_btc()) {
            write_btc_release(
                &owner,
                &BtcRelease { proposal_id: id, snapshot: btc_utxos.clone(), reserve: U64(btc_reserve), head: btc_utxos, signed: 0, last: None },
            );
        } else {
            env::storage_remove(&btc_release_key(&owner));
        }
        plan.proposal = Some(Proposal {
            id,
            plan_version: plan.version,
            proposer: g.clone(),
            created_at_ms: t,
            approvals: vec![],
            rejections: vec![],
            approved_at_ms: None,
            waiting_ends_at_ms: None,
            near_snapshot: U128(near_total),
            eth_snapshot: U128(eth_balance),
            eth_fee_reserve: U128(fee_reserve),
            transfers,
            eth_gas_limit: gas_limit,
        });
        self.open_releases.insert(owner.clone());
        // D21: what the proposer reported (or the contract counted), so
        // approvers and auditors can compare it with the live vault.
        let mut snap: Vec<(Asset, U128)> = vec![(Asset::Near, U128(near_total))];
        snap.extend(ft_snap.iter().map(|(t, b)| (Asset::Nep141(t.clone()), U128(*b))));
        if eth_balance > 0 {
            snap.push((Asset::Eth, U128(eth_balance)));
        }
        snap.extend(tokens.iter().map(|(t, b)| (Asset::Erc20(t.clone()), U128(*b))));
        if btc_total > 0 {
            snap.push((Asset::Btc, U128(btc_utxos_reported.iter().map(|u| u.value.0 as u128).sum())));
        }
        env::storage_write(&snapshot_key(&owner), &near_sdk::borsh::to_vec(&snap).expect("borsh"));
        if fixed_round.is_empty() {
            env::storage_remove(&fixed_round_key(&owner));
        } else {
            env::storage_write(&fixed_round_key(&owner), &near_sdk::borsh::to_vec(&fixed_round).expect("borsh"));
        }
        emit("release_proposed", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id, "proposer": g, "follow_up": follow_up}));
        if is_guardian {
            self.vote(owner, id, true);
        }
        id
    }

    /// P5.
    pub fn approve_release(&mut self, owner: AccountId, proposal_id: u64) {
        self.vote(owner, proposal_id, true);
    }

    /// P6.
    pub fn reject_release(&mut self, owner: AccountId, proposal_id: u64) {
        self.vote(owner, proposal_id, false);
    }

    // ----------------------------------------------------------------- heir

    /// P8 / T1a. Starts the caller's NEAR transfer. ETH transfers (T1b) are
    /// started by the Chain Signatures path, added in delivery step 4.
    /// Returns the number of transfers started. Each transfer is its own
    /// detached promise chain with its own callback: NEAR forbids returning a
    /// joint promise, and one transfer's outcome must not depend on another's.
    pub fn claim(&mut self, owner: AccountId) -> u32 {
        let heir = caller();
        let t = now();
        if self.paused {
            fail(Error::Paused);
        }
        let plan = self.plan_mut(&owner);
        // Heirs, plus an alternate or fallback once a transfer was reassigned to them.
        let holds = plan.proposal.as_ref().is_some_and(|p| p.transfers.iter().any(|t| t.heir == heir));
        if !holds && !plan.policy.heirs.iter().any(|h| h.account_id == heir) {
            fail(Error::NotHeir);
        }
        let p = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NotEligible));
        match p.waiting_ends_at_ms {
            Some(end) if t >= end => {}
            _ => fail(Error::NotEligible),
        }

        let mine: Vec<(usize, Asset)> = p
            .transfers
            .iter()
            .enumerate()
            .filter(|(_, tr)| tr.heir == heir)
            .filter(|(_, tr)| match tr.asset {
                // NEAR: start or retry. ETH: first attempt only; ETH retries
                // go through `retry_transfer` so the fee bump is explicit.
                Asset::Near | Asset::Nep141(_) => matches!(tr.state, TransferState::Pending | TransferState::Failed),
                Asset::Eth | Asset::Erc20(_) | Asset::Btc => tr.state == TransferState::Pending,
            })
            .map(|(i, tr)| (i, tr.asset.clone()))
            .collect();

        self.start(&owner, mine)
    }

    fn start(&mut self, owner: &AccountId, which: Vec<(usize, Asset)>) -> u32 {
        let started = which.len() as u32;
        for (i, asset) in which {
            self.send(owner, i, &asset).detach();
        }
        started
    }

    fn send(&mut self, owner: &AccountId, i: usize, asset: &Asset) -> Promise {
        if asset.is_evm() {
            self.sign_eth(owner, i)
        } else if asset.is_btc() {
            self.sign_btc(owner, i)
        } else {
            self.send_near(owner, i)
        }
    }

    /// D19. Starts `heir`'s pending transfers without them: anyone may call it
    /// (the executor does) once the plan is claimable in `Automatic` mode, or
    /// after the grace period in `Hybrid`. Destinations and amounts are the
    /// approved ones; failed transfers are retried by the heir or an executor.
    pub fn release(&mut self, owner: AccountId, heir: AccountId) -> u32 {
        if self.paused {
            fail(Error::Paused);
        }
        let opts = read_options(&owner).unwrap_or_default();
        let t = now();
        let plan = self.plan_ref(&owner);
        let p = plan.proposal.as_ref().unwrap_or_else(|| fail(Error::NotEligible));
        let end = match p.waiting_ends_at_ms {
            Some(end) if t >= end => end,
            _ => fail(Error::NotEligible),
        };
        // Each transfer follows the mode for its heir and asset group.
        let open = |tr: &Transfer| match policy::mode_for(&opts, &tr.heir, &tr.asset) {
            (ReleaseMode::Claim, _) => false,
            (ReleaseMode::Automatic, _) => true,
            (ReleaseMode::Hybrid, grace) => t >= end + grace,
        };
        let mine: Vec<(usize, &Transfer)> = p.transfers.iter().enumerate().filter(|(_, tr)| tr.heir == heir).collect();
        if !mine.iter().any(|(_, tr)| open(tr)) {
            fail(Error::NotReleasable);
        }
        let which: Vec<(usize, Asset)> = mine
            .into_iter()
            .filter(|(_, tr)| tr.state == TransferState::Pending && open(tr))
            .map(|(i, tr)| (i, tr.asset.clone()))
            .collect();
        emit("released", near_sdk::serde_json::json!({"owner": owner, "heir": heir, "by": caller(), "transfers": which.len()}));
        self.start(&owner, which)
    }

    // ----------------------------------------------------------- delay signers

    /// D18. A delay signer asks to extend an approved release's waiting period
    /// (and with it the owner's cancel window and the signing cutoff). Counts
    /// as their vote; it applies once `delay_quorum` signers agree. Only one
    /// request at a time; `reason` is a short code, never evidence.
    pub fn request_extension(&mut self, owner: AccountId, proposal_id: u64, extension_ms: u64, reason: Option<String>) {
        let (opts, mut ext) = self.extension_context(&owner, proposal_id);
        if ext.pending.is_some() {
            fail(Error::ExtensionPending);
        }
        if extension_ms == 0 || extension_ms > opts.max_extension_ms || ext.total_ms + extension_ms > opts.max_total_extension_ms {
            fail(Error::ExtensionTooLong);
        }
        let reason = reason.map(|r| r.chars().take(64).collect::<String>()).filter(|r| !r.is_empty());
        ext.pending = Some(PendingExtension { extension_ms, reason: reason.clone(), votes: vec![] });
        emit("extension_requested", near_sdk::serde_json::json!({"owner": owner, "proposal_id": proposal_id, "by": caller(), "extension_ms": extension_ms, "reason": reason}));
        self.vote_extension(&owner, ext, &opts);
    }

    pub fn approve_extension(&mut self, owner: AccountId, proposal_id: u64) {
        let (opts, ext) = self.extension_context(&owner, proposal_id);
        if ext.pending.is_none() {
            fail(Error::NoProposal);
        }
        self.vote_extension(&owner, ext, &opts);
    }

    pub fn get_extension(&self, owner: AccountId) -> Option<ExtensionState> {
        let id = self.read_plan(&owner)?.proposal?.id;
        read_extension(&owner).filter(|e| e.proposal_id == id)
    }

    /// The caller is a delay signer and the release is approved and still waiting.
    fn extension_context(&self, owner: &AccountId, proposal_id: u64) -> (ReleaseOptions, ExtensionState) {
        let opts = read_options(owner).unwrap_or_default();
        if !opts.delay_signers.contains(&caller()) {
            fail(Error::NotDelaySigner);
        }
        let plan = self.plan_ref(owner);
        let p = plan.proposal.as_ref().filter(|p| p.id == proposal_id).unwrap_or_else(|| fail(Error::NoProposal));
        match p.waiting_ends_at_ms {
            Some(end) if now() < end => {}
            _ => fail(Error::NotEligible),
        }
        let ext = read_extension(owner).filter(|e| e.proposal_id == proposal_id).unwrap_or(ExtensionState { proposal_id, total_ms: 0, count: 0, pending: None });
        (opts, ext)
    }

    fn vote_extension(&mut self, owner: &AccountId, mut ext: ExtensionState, opts: &ReleaseOptions) {
        let who = caller();
        let pending = ext.pending.as_mut().expect("checked");
        if pending.votes.contains(&who) {
            fail(Error::AlreadyVoted);
        }
        pending.votes.push(who);
        if pending.votes.len() >= opts.delay_quorum as usize {
            let ms = pending.extension_ms;
            ext.pending = None;
            ext.total_ms += ms;
            ext.count += 1;
            let plan = self.plan_mut(owner);
            let p = plan.proposal.as_mut().expect("checked");
            let end = p.waiting_ends_at_ms.expect("checked") + ms;
            p.waiting_ends_at_ms = Some(end);
            emit("waiting_extended", near_sdk::serde_json::json!({"owner": owner, "proposal_id": ext.proposal_id, "extension_ms": ms, "waiting_ends_at_ms": end, "total_ms": ext.total_ms}));
        }
        env::storage_write(&extension_key(owner), &near_sdk::borsh::to_vec(&ext).expect("borsh"));
    }

    /// T6. Retry a `Failed` transfer. ETH re-signs the same nonce, recipient
    /// and value with fees bumped (bounded by the cap).
    pub fn retry_transfer(&mut self, owner: AccountId, index: u32) -> Promise {
        if self.paused {
            fail(Error::Paused);
        }
        let who = caller();
        let is_executor = self.executors.contains(&who);
        let tr = self.tr_get(&owner, index);
        if tr.heir != who && !is_executor {
            fail(Error::Unauthorized);
        }
        if tr.state != TransferState::Failed {
            fail(Error::InvalidTransferState);
        }
        let asset = tr.asset.clone();
        self.send(&owner, index as usize, &asset)
    }

    /// T1a callback.
    #[private]
    pub fn on_near_transfer(&mut self, owner: AccountId, index: u32) {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 0).is_ok();
        let tr = self.transfer_mut(&owner, index);
        if ok {
            tr.state = TransferState::Confirmed;
        } else {
            tr.state = TransferState::Failed;
            tr.failure = Some("PromiseFailed".into());
        }
        let state = tr.state;
        emit_transfer(&owner, index, state);
        self.close_if_settled(&owner);
    }

    /// T2. MPC signature callback. Callbacks from superseded attempts are ignored.
    #[private]
    pub fn on_eth_signed(&mut self, owner: AccountId, index: u32, attempt: u32) {
        let response = env::promise_result_checked(0, MAX_MPC_RESPONSE_BYTES)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<SignatureResponse>(&b).ok());
        let mut owned = self.tr_get(&owner, index);
        let tr = &mut owned;
        if tr.attempts != attempt || tr.state != TransferState::Signing {
            return;
        }
        match response {
            Some(SignatureResponse::Secp256k1 { big_r, s, recovery_id })
                if big_r.affine_point.len() == 66 && s.scalar.len() == 64 && recovery_id <= 1 =>
            {
                let sig = EthSignature {
                    big_r: big_r.affine_point.to_ascii_lowercase(),
                    s: s.scalar.to_ascii_lowercase(),
                    recovery_id,
                };
                let params = tr.eth_tx.clone().expect("signing implies eth_tx");
                if !tr.signed_versions.iter().any(|v| v.eth_tx.payload_hash == params.payload_hash) {
                    if tr.signed_versions.len() >= MAX_SIGNED_VERSIONS {
                        tr.signed_versions.remove(0);
                    }
                    tr.signed_versions.push(SignedVersion { eth_tx: params, signature: sig.clone() });
                }
                tr.signature = Some(sig);
                tr.state = TransferState::Signed;
            }
            _ => {
                tr.state = TransferState::Failed;
                tr.failure = Some("SignFailed".into());
            }
        }
        let state = tr.state;
        self.tr_put(&owner, index, owned);
        emit_transfer(&owner, index, state);
    }

    // ------------------------------------------------------------- executor

    /// T3. Executor reports the hash of the broadcast signed transaction.
    pub fn report_broadcast(&mut self, owner: AccountId, index: u32, tx_hash: String) {
        self.assert_executor();
        let mut tr = self.tr_get(&owner, index);
        if tr.asset.is_btc() {
            return self.report_btc_broadcast(&owner, index, tr, tx_hash);
        }
        if !tr.asset.is_external() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
            fail(Error::InvalidTransferState);
        }
        tr.tx_hash = Some(tx_hash);
        tr.state = TransferState::Broadcast;
        self.tr_put(&owner, index, tr);
        emit_transfer(&owner, index, TransferState::Broadcast);
    }

    /// T4. Executor reports inclusion with the required confirmations.
    pub fn report_confirmed(&mut self, owner: AccountId, index: u32, tx_hash: String) {
        self.assert_executor();
        let mut tr = self.tr_get(&owner, index);
        if tr.state == TransferState::Confirmed && tr.tx_hash.as_deref() == Some(tx_hash.as_str()) {
            return;
        }
        if tr.state != TransferState::Broadcast || tr.tx_hash.as_deref() != Some(tx_hash.as_str()) {
            fail(Error::InvalidTransferState);
        }
        tr.state = TransferState::Confirmed;
        self.tr_put(&owner, index, tr);
        emit_transfer(&owner, index, TransferState::Confirmed);
        if index != VAULT_WITHDRAWAL {
            self.close_if_settled(&owner);
        }
    }

    /// T5. Executor reports a failure (reason code, e.g. FeeAboveCap, NonceGap, Dropped).
    pub fn report_failed(&mut self, owner: AccountId, index: u32, reason: String) {
        self.assert_executor();
        let mut tr = self.tr_get(&owner, index);
        if !tr.asset.is_external() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
            fail(Error::InvalidTransferState);
        }
        tr.state = TransferState::Failed;
        tr.failure = Some(reason.chars().take(64).collect());
        self.tr_put(&owner, index, tr);
        emit_transfer(&owner, index, TransferState::Failed);
    }

    // ---------------------------------------------------------------- admin

    pub fn add_executor(&mut self, account_id: AccountId) {
        self.assert_admin();
        self.executors.insert(account_id);
    }

    pub fn remove_executor(&mut self, account_id: AccountId) {
        self.assert_admin();
        self.executors.remove(&account_id);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_admin();
        self.paused = paused;
    }

    /// Gas limit for proposals opened from now on (open proposals keep theirs).
    pub fn set_eth_gas_limit(&mut self, gas_limit: u64) {
        self.assert_admin();
        assert_gas_limit(gas_limit);
        self.eth_gas_limit = gas_limit;
    }

/// Re-issues an ETH/ERC-20 transfer whose transaction was mined but
    /// reverted, under the next nonce. Allowed only after `prove_eth_outcome`
    /// proved the revert (D22, threat 20), so anyone may call it: nobody's word
    /// is needed that the old nonce paid nothing.
    pub fn reissue_reverted_transfer(&mut self, owner: AccountId, index: u32) -> Promise {
        if self.paused {
            fail(Error::Paused);
        }
        let gas_limit = self.eth_gas_limit;
        let proven = env::storage_read(&revert_proof_key(&owner, index));
        let plan = self.plan_mut(&owner);
        let next_nonce = plan.eth_next_nonce;
        let p = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal));
        let tr = p.transfers.get_mut(index as usize).unwrap_or_else(|| fail(Error::BadIndex));
        if !tr.asset.is_evm() || tr.state != TransferState::Failed || tr.failure.as_deref() != Some("Reverted") {
            fail(Error::InvalidTransferState);
        }
        if proven.is_none() || proven.as_deref().map(|h| eth::hex_encode(h)) != tr.tx_hash.as_deref().map(|h| h.trim_start_matches("0x").to_ascii_lowercase()) {
            fail(Error::RevertNotProven);
        }
        env::storage_remove(&revert_proof_key(&owner, index));
        let old_nonce = tr.eth_tx.as_ref().map(|t| t.nonce);
        tr.eth_tx = None; // sign_eth assigns the next nonce and initial fees
        p.eth_gas_limit = p.eth_gas_limit.max(gas_limit);
        emit(
            "transfer_reissued",
            near_sdk::serde_json::json!({"owner": owner, "index": index, "old_nonce": old_nonce, "new_nonce": next_nonce}),
        );
        self.sign_eth(&owner, index as usize)
    }

    /// D22. Proves how an ETH/ERC-20 transfer's transaction ended on Sepolia:
    /// the block header, the transaction's index and Merkle-Patricia proofs of
    /// the transaction and its receipt (built by any Sepolia node; see the
    /// executor's `ethproof.ts`). The contract checks the proofs, that the
    /// transaction is one this contract signed for the transfer's current
    /// nonce, and asks the Ethereum light client whether the header is final.
    /// Success confirms the transfer; a revert marks it Failed("Reverted") and
    /// unlocks `reissue_reverted_transfer`. Anyone may call it.
    pub fn prove_eth_outcome(&mut self, owner: AccountId, index: u32, proof: EthOutcomeProof) -> Promise {
        let lc = eth_light_client().unwrap_or_else(|| fail(Error::NoLightClient));
        let tr = self.tr_get(&owner, index);
        if !tr.asset.is_evm() || tr.state == TransferState::Confirmed {
            fail(Error::InvalidTransferState);
        }
        let dec = |v: &str| eth::hex_decode(v.trim_start_matches("0x")).unwrap_or_else(|| fail(Error::InvalidProof));
        if proof.tx_proof.len() > MAX_PROOF_NODES || proof.receipt_proof.len() > MAX_PROOF_NODES {
            fail(Error::InvalidProof);
        }
        let header = dec(&proof.header);
        let txp: Vec<Vec<u8>> = proof.tx_proof.iter().map(|n| dec(n)).collect();
        let rp: Vec<Vec<u8>> = proof.receipt_proof.iter().map(|n| dec(n)).collect();
        let out = ethproof::verify_outcome(&header, proof.tx_index as u64, &txp, &rp).unwrap_or_else(|e| {
            log!("proof: {}", e);
            fail(Error::InvalidProof)
        });
        let tx_hash = format!("0x{}", eth::hex_encode(&out.tx_hash));
        if signed_nonce_of(&tr, &tx_hash) != Some(tr.eth_tx.as_ref().map(|t| t.nonce).unwrap_or(u64::MAX)) {
            fail(Error::InvalidProof); // not ours, or a nonce this transfer no longer uses
        }
        Promise::new(lc)
            .function_call("block_hash_safe".to_string(), out.block_number.to_le_bytes().to_vec(), NearToken::from_yoctonear(0), LIGHT_CLIENT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(PROOF_CALLBACK_GAS).on_eth_outcome_checked(
                owner,
                index,
                tx_hash,
                format!("0x{}", eth::hex_encode(&out.block_hash)),
                out.success,
            ))
    }

    #[private]
    pub fn on_eth_outcome_checked(&mut self, owner: AccountId, index: u32, tx_hash: String, block_hash: String, success: bool) -> bool {
        // block_hash_safe returns borsh Option<[u8; 32]>: Some only for finalized blocks it still keeps
        let finalized = env::promise_result_checked(0, 64)
            .ok()
            .filter(|b| b.len() == 33 && b[0] == 1)
            .map(|b| format!("0x{}", eth::hex_encode(&b[1..])));
        if finalized.as_deref() != Some(block_hash.as_str()) {
            log!("block {} is not final in the light client", block_hash);
            return false;
        }
        let Some(mut tr) = self.tr_read(&owner, index) else { return false };
        let nonce = tr.eth_tx.as_ref().map(|t| t.nonce);
        if tr.state == TransferState::Confirmed || signed_nonce_of(&tr, &tx_hash) != nonce || nonce.is_none() {
            return false; // changed while the light client answered
        }
        tr.tx_hash = Some(tx_hash.clone());
        if success {
            tr.state = TransferState::Confirmed;
            tr.failure = None;
        } else {
            tr.state = TransferState::Failed;
            tr.failure = Some("Reverted".into());
            if index != VAULT_WITHDRAWAL {
                env::storage_write(&revert_proof_key(&owner, index), &eth::hex_decode(tx_hash.trim_start_matches("0x")).expect("hex"));
            }
        }
        let state = tr.state;
        self.tr_put(&owner, index, tr);
        emit("eth_outcome_proven", near_sdk::serde_json::json!({"owner": owner, "index": index, "tx_hash": tx_hash, "block_hash": block_hash, "success": success}));
        emit_transfer(&owner, index, state);
        if success && index != VAULT_WITHDRAWAL {
            self.close_if_settled(&owner);
        }
        true
    }

    /// The transaction hash proven to have reverted for a transfer, if any.
    pub fn get_revert_proof(&self, owner: AccountId, index: u32) -> Option<String> {
        env::storage_read(&revert_proof_key(&owner, index)).map(|h| format!("0x{}", eth::hex_encode(&h)))
    }

    pub fn set_eth_light_client(&mut self, account_id: Option<AccountId>) {
        self.assert_admin();
        match account_id {
            Some(a) => env::storage_write(ETH_LIGHT_CLIENT_KEY, a.as_bytes()),
            None => env::storage_remove(ETH_LIGHT_CLIENT_KEY),
        };
    }

    /// Replaces the ERC-20 allowlist. Open proposals keep the token addresses
    /// they snapshotted; this only affects proposals opened afterwards.
    pub fn set_erc20_tokens(&mut self, tokens: Vec<Erc20Token>) {
        self.assert_admin();
        if tokens.len() > MAX_ERC20_TOKENS {
            fail(Error::UnknownToken);
        }
        let mut clean: Vec<Erc20Token> = vec![];
        for t in tokens {
            let address = t.address.to_ascii_lowercase();
            if eth::parse_address(&address).is_none() || clean.iter().any(|c| c.address == address) {
                fail(Error::InvalidEthAddress);
            }
            clean.push(Erc20Token { address, symbol: t.symbol.chars().take(12).collect(), decimals: t.decimals });
        }
        env::storage_write(ERC20_TOKENS_KEY, &near_sdk::borsh::to_vec(&clean).expect("borsh"));
        emit("erc20_tokens_set", near_sdk::serde_json::json!({"tokens": clean}));
    }

    /// Replaces the NEP-141 allowlist and registers this contract with every
    /// newly listed token (a token only accepts transfers to registered
    /// accounts), paid from the attached deposit. Open proposals keep their snapshotted
    /// token transfers; escrow of a delisted token stays withdrawable only
    /// after it is listed again (withdraw_ft reads escrow by token id).
    #[payable]
    pub fn set_nep141_tokens(&mut self, tokens: Vec<Nep141Token>) {
        self.assert_admin();
        let before = nep141_tokens();
        if tokens.len() > MAX_NEP141_TOKENS {
            fail(Error::UnknownToken);
        }
        let mut clean: Vec<Nep141Token> = vec![];
        for t in tokens {
            if clean.iter().any(|c| c.account_id == t.account_id) {
                fail(Error::UnknownToken);
            }
            clean.push(Nep141Token { symbol: t.symbol.chars().take(12).collect(), ..t });
        }
        let added: Vec<&Nep141Token> = clean.iter().filter(|t| !before.iter().any(|b| b.account_id == t.account_id)).collect();
        let needed: u128 = added.iter().map(|t| t.storage_deposit.0).sum();
        if env::attached_deposit().as_yoctonear() < needed {
            fail(Error::InsufficientDeposit);
        }
        for t in added {
            Promise::new(t.account_id.clone())
                .function_call(
                    "storage_deposit",
                    near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"account_id": env::current_account_id(), "registration_only": true})).expect("json"),
                    NearToken::from_yoctonear(t.storage_deposit.0),
                    FT_GAS,
                )
                .detach();
        }
        env::storage_write(NEP141_TOKENS_KEY, &near_sdk::borsh::to_vec(&clean).expect("borsh"));
        emit("nep141_tokens_set", near_sdk::serde_json::json!({"tokens": clean}));
    }

    pub fn get_erc20_tokens(&self) -> Vec<Erc20Token> {
        erc20_tokens()
    }

    pub fn set_eth_fees(&mut self, max_fee_cap: U128, initial_max_fee: U128, priority_fee: U128) {
        self.assert_admin();
        self.eth_max_fee_cap = max_fee_cap;
        self.eth_initial_max_fee = initial_max_fee;
        self.eth_priority_fee = priority_fee;
    }

    // ---------------------------------------------------------------- views

    pub fn get_plan(&self, owner: AccountId) -> Option<PlanView> {
        self.read_plan(&owner).map(|plan| PlanView {
            status: status_of(&plan, now()),
            overdue_at_ms: overdue_at(&plan),
            now_ms: now(),
            ft_escrow: nep141_tokens()
                .iter()
                .map(|t| TokenBalance { token: t.account_id.to_string(), amount: U128(ft_escrow(&t.account_id, &owner)) })
                .collect(),
            plan,
        })
    }

    /// Raw signed transaction (`0x…`) for a `Signed`/`Broadcast` ETH transfer.
    /// Anyone can broadcast it; the executor is a convenience, not an authority.
    pub fn get_signed_tx(&self, owner: AccountId, index: u32) -> Option<String> {
        let tr = self.tr_read(&owner, index)?;
        raw_signed_tx(&tr, tr.eth_tx.as_ref()?, tr.signature.as_ref()?)
    }

    /// Every signed version of an ETH transfer (oldest first), as raw `0x…`
    /// transactions. They share one nonce, so at most one can be mined.
    pub fn get_signed_tx_versions(&self, owner: AccountId, index: u32) -> Vec<String> {
        let Some(tr) = self.tr_read(&owner, index) else {
            return vec![];
        };
        tr.signed_versions.iter().filter_map(|v| raw_signed_tx(&tr, &v.eth_tx, &v.signature)).collect()
    }

    /// The owner's latest vault withdrawal (also readable as transfer VAULT_WITHDRAWAL).
    pub fn get_vault_withdrawal(&self, owner: AccountId) -> Option<Transfer> {
        read_withdrawal(&owner)
    }

    /// Owners whose vault withdrawal is unresolved (for executors).
    pub fn list_vault_withdrawals(&self) -> Vec<AccountId> {
        pending_withdrawals()
    }

    /// Owners with an open (unsettled) release, paginated.
    pub fn list_open_releases(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        self.open_releases
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    /// Derivation path of the owner's Sepolia vault (predecessor = this contract).
    pub fn get_eth_vault_path(&self, owner: AccountId) -> String {
        eth_vault_path(&owner)
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            admin: self.admin.clone(),
            mpc_contract: self.mpc_contract.clone(),
            eth_chain_id: self.eth_chain_id,
            eth_gas_limit: self.eth_gas_limit,
            erc20_tokens: erc20_tokens(),
            nep141_tokens: nep141_tokens(),
            btc: btc_config(),
            eth_light_client: eth_light_client(),
            eth_max_fee_cap: self.eth_max_fee_cap,
            eth_initial_max_fee: self.eth_initial_max_fee,
            eth_priority_fee: self.eth_priority_fee,
            paused: self.paused,
            executors: self.executors.iter().cloned().collect(),
            demo_timers: cfg!(feature = "demo-timers"),
        }
    }
}

// -------------------------------------------------------------- internals

/// A proposal exists and not every transfer has landed. Owner withdrawals
/// are frozen only then; after settlement remainders can be taken back.
fn release_open(plan: &Plan) -> bool {
    plan.proposal.as_ref().is_some_and(|p| !p.transfers.iter().all(|t| t.state == TransferState::Confirmed))
}

fn overdue_at(plan: &Plan) -> u64 {
    plan.last_check_in_ms + plan.policy.check_in_interval_ms + plan.policy.grace_ms
}

/// The single source of truth for derived plan states (01-state-machine.md).
pub fn status_of(plan: &Plan, t: u64) -> PlanStatus {
    match &plan.proposal {
        None if t < overdue_at(plan) => PlanStatus::Active,
        None => PlanStatus::Overdue,
        Some(p) => match p.waiting_ends_at_ms {
            None => PlanStatus::Proposed,
            Some(end) if t < end => PlanStatus::Waiting,
            Some(_) => {
                if p.transfers.iter().all(|x| x.state == TransferState::Confirmed) {
                    PlanStatus::Settled
                } else if p.transfers.iter().any(|x| x.state != TransferState::Pending) {
                    PlanStatus::Executing
                } else {
                    PlanStatus::Eligible
                }
            }
        },
    }
}

fn withdrawal_key(owner: &AccountId) -> Vec<u8> {
    [WITHDRAWAL_PREFIX, owner.as_bytes()].concat()
}

const MAX_HISTORY: usize = 5;

fn history_key(owner: &AccountId) -> Vec<u8> {
    format!("hist:{owner}").into_bytes()
}

fn read_history(owner: &AccountId) -> Vec<Proposal> {
    env::storage_read(&history_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

/// When the latest archived release was proposed (its round began).
fn last_settled_at(owner: &AccountId) -> Option<u64> {
    read_history(owner).last().map(|p| p.created_at_ms)
}

fn snapshot_key(owner: &AccountId) -> Vec<u8> {
    format!("snap:{owner}").into_bytes()
}

fn fixed_paid_key(owner: &AccountId) -> Vec<u8> {
    format!("fixp:{owner}").into_bytes()
}

fn fixed_round_key(owner: &AccountId) -> Vec<u8> {
    format!("fixr:{owner}").into_bytes()
}

fn read_fixed_paid(owner: &AccountId) -> Vec<FixedAmount> {
    env::storage_read(&fixed_paid_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn read_withdrawal(owner: &AccountId) -> Option<Transfer> {
    env::storage_read(&withdrawal_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

/// Unresolved: not yet confirmed, and not a mined revert (whose nonce is used).
fn withdrawal_busy(w: &Option<Transfer>) -> bool {
    w.as_ref().is_some_and(|t| t.state != TransferState::Confirmed && !(t.state == TransferState::Failed && matches!(t.failure.as_deref(), Some("Reverted") | Some("Cancelled"))))
}

fn pending_withdrawals() -> Vec<AccountId> {
    env::storage_read(PENDING_WITHDRAWALS_KEY).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

/// Stores the record and keeps the pending list in step with it.
fn write_withdrawal(owner: &AccountId, tr: &Transfer) {
    env::storage_write(&withdrawal_key(owner), &near_sdk::borsh::to_vec(tr).expect("borsh"));
    let mut pending = pending_withdrawals();
    let busy = withdrawal_busy(&Some(tr.clone()));
    let listed = pending.contains(owner);
    if busy != listed {
        if busy {
            pending.push(owner.clone());
        } else {
            pending.retain(|o| o != owner);
        }
        env::storage_write(PENDING_WITHDRAWALS_KEY, &near_sdk::borsh::to_vec(&pending).expect("borsh"));
    }
}

fn options_key(owner: &AccountId) -> Vec<u8> {
    [b"opts:".as_slice(), owner.as_bytes()].concat()
}

fn read_options(owner: &AccountId) -> Option<ReleaseOptions> {
    let b = env::storage_read(&options_key(owner))?;
    if let Ok(o) = near_sdk::borsh::from_slice::<ReleaseOptions>(&b) {
        return Some(o);
    }
    let v1: ReleaseOptionsV1 = near_sdk::borsh::from_slice(&b).ok()?;
    Some(ReleaseOptions {
        mode: v1.mode,
        hybrid_grace_ms: v1.hybrid_grace_ms,
        delay_signers: v1.delay_signers,
        delay_quorum: v1.delay_quorum,
        max_extension_ms: v1.max_extension_ms,
        max_total_extension_ms: v1.max_total_extension_ms,
        overrides: vec![],
    })
}

fn extension_key(owner: &AccountId) -> Vec<u8> {
    [b"ext:".as_slice(), owner.as_bytes()].concat()
}

fn read_extension(owner: &AccountId) -> Option<ExtensionState> {
    env::storage_read(&extension_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn btc_config() -> BtcConfig {
    env::storage_read(BTC_CONFIG_KEY).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or(BtcConfig { fee_rate: 2, max_fee_rate: 5 })
}

fn btc_dests_key(owner: &AccountId) -> Vec<u8> {
    [b"btcd:".as_slice(), owner.as_bytes()].concat()
}

fn btc_dests(owner: &AccountId) -> Vec<BtcDestination> {
    env::storage_read(&btc_dests_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn btc_dest(owner: &AccountId, account: &AccountId) -> Option<String> {
    btc_dests(owner).into_iter().find(|d| &d.account_id == account).map(|d| d.address)
}

fn btc_pubkey_key(owner: &AccountId) -> Vec<u8> {
    [b"btcpk:".as_slice(), owner.as_bytes()].concat()
}

fn btc_pubkey(owner: &AccountId) -> Option<[u8; 33]> {
    env::storage_read(&btc_pubkey_key(owner)).and_then(|b| b.try_into().ok())
}

fn btc_release_key(owner: &AccountId) -> Vec<u8> {
    [b"btcp:".as_slice(), owner.as_bytes()].concat()
}

fn read_btc_release(owner: &AccountId) -> Option<BtcRelease> {
    env::storage_read(&btc_release_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn write_btc_release(owner: &AccountId, r: &BtcRelease) {
    env::storage_write(&btc_release_key(owner), &near_sdk::borsh::to_vec(r).expect("borsh"));
}

fn btx_key(owner: &AccountId, index: u32, pid: Option<u64>) -> Vec<u8> {
    match pid {
        Some(id) => format!("btx:{owner}:{id}:{index}").into_bytes(),
        None => format!("btx:{owner}:w").into_bytes(),
    }
}

fn read_btx(owner: &AccountId, index: u32, pid: Option<u64>) -> Option<BtcTx> {
    env::storage_read(&btx_key(owner, index, pid)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn write_btx(owner: &AccountId, index: u32, pid: Option<u64>, b: &BtcTx) {
    env::storage_write(&btx_key(owner, index, pid), &near_sdk::borsh::to_vec(b).expect("borsh"));
}

fn remove_btx(owner: &AccountId, index: u32, pid: Option<u64>) {
    env::storage_remove(&btx_key(owner, index, pid));
    env::storage_remove(&btxv_key(owner, index, pid));
}

/// Earlier signed versions of a payout that a fee bump replaced (newest last).
/// Any of them may still be the one the network mines.
fn btxv_key(owner: &AccountId, index: u32, pid: Option<u64>) -> Vec<u8> {
    let mut k = b"btxv".to_vec();
    k.extend_from_slice(&btx_key(owner, index, pid)[3..]);
    k
}

fn read_btx_versions(owner: &AccountId, index: u32, pid: Option<u64>) -> Vec<BtcTx> {
    env::storage_read(&btxv_key(owner, index, pid)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn write_btx_versions(owner: &AccountId, index: u32, pid: Option<u64>, v: &Vec<BtcTx>) {
    env::storage_write(&btxv_key(owner, index, pid), &near_sdk::borsh::to_vec(v).expect("borsh"));
}

/// The vault change a payout leaves (output 1), if any.
fn btc_change(b: &BtcTx) -> Vec<BtcUtxo> {
    b.outputs.get(1).map(|o| vec![BtcUtxo { txid: b.txid.clone(), vout: 1, value: o.value }]).unwrap_or_default()
}

/// Validates reported coins: 1..=MAX_BTC_INPUTS distinct outpoints with a
/// 64-hex txid and a non-zero value. Returns (count, total sats).
fn check_utxos(u: &[BtcUtxo]) -> (usize, u64) {
    if u.is_empty() || u.len() > MAX_BTC_INPUTS {
        fail(Error::InvalidUtxos);
    }
    let mut total = 0u64;
    for (i, x) in u.iter().enumerate() {
        let ok = x.txid.len() == 64 && eth::hex_decode(&x.txid).is_some() && x.value.0 > 0 && !u[..i].iter().any(|y| y.txid == x.txid && y.vout == x.vout);
        if !ok {
            fail(Error::InvalidUtxos);
        }
        total = total.checked_add(x.value.0).unwrap_or_else(|| fail(Error::InvalidUtxos));
    }
    (u.len(), total)
}

fn to_tx(b: &BtcTx) -> btc::Tx {
    btc::Tx {
        inputs: b
            .inputs
            .iter()
            .map(|u| btc::Input { txid: eth::hex_decode(&u.txid.to_ascii_lowercase()).and_then(|v| v.try_into().ok()).expect("checked"), vout: u.vout, value: u.value.0 })
            .collect(),
        outputs: b.outputs.iter().map(|o| btc::Output { script: eth::hex_decode(&o.script).expect("own"), value: o.value.0 }).collect(),
    }
}

fn base58_decode(s: &str) -> Option<Vec<u8>> {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out: Vec<u8> = vec![];
    for c in s.bytes() {
        let mut carry = A.iter().position(|x| *x == c)? as u32;
        for b in out.iter_mut().rev() {
            carry += (*b as u32) * 58;
            *b = carry as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.insert(0, carry as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|c| *c == b'1').count();
    let mut v = vec![0u8; zeros];
    v.extend(out);
    Some(v)
}

fn rules_key(owner: &AccountId) -> Vec<u8> {
    [b"rules:".as_slice(), owner.as_bytes()].concat()
}

fn read_rules(owner: &AccountId) -> Option<ReleaseRules> {
    env::storage_read(&rules_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

/// Where `r` receives `asset`: its NEAR account or its Ethereum address.
fn dest_for(owner: &AccountId, r: &Recipient, asset: &Asset) -> Option<String> {
    if asset.is_evm() {
        r.eth_destination.clone()
    } else if asset.is_btc() {
        btc_dest(owner, &r.account_id)
    } else {
        r.near_destination.as_ref().map(|a| a.to_string())
    }
}

fn nep141_tokens() -> Vec<Nep141Token> {
    env::storage_read(NEP141_TOKENS_KEY).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn ft_key(token: &AccountId, owner: &AccountId) -> Vec<u8> {
    [b"ft:".as_slice(), token.as_bytes(), b":", owner.as_bytes()].concat()
}

fn ft_escrow(token: &AccountId, owner: &AccountId) -> u128 {
    env::storage_read(&ft_key(token, owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or(0)
}

fn set_ft_escrow(token: &AccountId, owner: &AccountId, amount: u128) {
    let key = ft_key(token, owner);
    if amount == 0 {
        env::storage_remove(&key);
    } else {
        env::storage_write(&key, &near_sdk::borsh::to_vec(&amount).expect("borsh"));
    }
}

fn ft_reserve_key(owner: &AccountId) -> Vec<u8> {
    [b"ftr:".as_slice(), owner.as_bytes()].concat()
}

/// NEAR set aside at proposal time for registering heirs with tokens.
fn ft_reserve(owner: &AccountId) -> u128 {
    env::storage_read(&ft_reserve_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or(0)
}

fn set_ft_reserve(owner: &AccountId, amount: u128) {
    if amount == 0 {
        env::storage_remove(&ft_reserve_key(owner));
    } else {
        env::storage_write(&ft_reserve_key(owner), &near_sdk::borsh::to_vec(&amount).expect("borsh"));
    }
}

/// NEP-141 `ft_transfer` (1 yoctoNEAR attached, as the standard requires).
fn ft_transfer(token: &AccountId, to: &AccountId, amount: u128, memo: &str) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer",
        near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"receiver_id": to, "amount": U128(amount), "memo": memo})).expect("json"),
        NearToken::from_yoctonear(1),
        FT_GAS,
    )
}

fn erc20_tokens() -> Vec<Erc20Token> {
    env::storage_read(ERC20_TOKENS_KEY)
        .and_then(|b| near_sdk::borsh::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The (to, value, data) a vault transaction carries for an EVM transfer:
/// ETH goes straight to the heir; a token transfer calls the token contract.
fn evm_call(tr: &Transfer) -> Option<([u8; 20], u128, Vec<u8>)> {
    let dest = eth::parse_address(&tr.destination)?;
    match &tr.asset {
        Asset::Eth => Some((dest, tr.amount.0, vec![])),
        Asset::Erc20(token) => Some((eth::parse_address(token)?, 0, eth::erc20_transfer_data(&dest, tr.amount.0))),
        Asset::Near | Asset::Nep141(_) | Asset::Btc => None,
    }
}

fn eth_light_client() -> Option<AccountId> {
    env::storage_read(ETH_LIGHT_CLIENT_KEY).and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
}

fn revert_proof_key(owner: &AccountId, index: u32) -> Vec<u8> {
    format!("rvp:{}:{}", owner, index).into_bytes()
}

/// The nonce of the signed version of `tr` whose hash is `tx_hash`, if any.
fn signed_nonce_of(tr: &Transfer, tx_hash: &str) -> Option<u64> {
    let want = tx_hash.trim_start_matches("0x").to_ascii_lowercase();
    tr.signed_versions.iter().find_map(|v| {
        let raw = raw_signed_tx(tr, &v.eth_tx, &v.signature)?;
        let bytes = eth::hex_decode(raw.trim_start_matches("0x"))?;
        (eth::hex_encode(&env::keccak256_array(&bytes)) == want).then_some(v.eth_tx.nonce)
    })
}

fn raw_signed_tx(tr: &Transfer, params: &EthTxParams, sig: &EthSignature) -> Option<String> {
    let (to, value, data) = evm_call(tr)?;
    let big_r = eth::hex_decode(&sig.big_r)?;
    let tx = eth::EthTransfer {
        chain_id: params.chain_id,
        nonce: params.nonce,
        max_priority_fee_per_gas: params.max_priority_fee_per_gas.0,
        max_fee_per_gas: params.max_fee_per_gas.0,
        gas_limit: params.gas_limit,
        to: &to,
        value,
        data: &data,
    };
    let rsv = eth::RsvSignature {
        r: big_r.get(1..33)?.try_into().ok()?,
        s: eth::hex_decode(&sig.s)?.try_into().ok()?,
        y_parity: sig.recovery_id,
    };
    Some(format!("0x{}", eth::hex_encode(&tx.signed(&rsv))))
}

fn assert_gas_limit(gas_limit: u64) {
    if !(MIN_ETH_GAS_LIMIT..=MAX_ETH_GAS_LIMIT).contains(&gas_limit) {
        env::panic_str("E_BAD_GAS_LIMIT: gas limit out of bounds");
    }
}

fn emit_transfer(owner: &AccountId, index: u32, state: TransferState) {
    emit("transfer_update", near_sdk::serde_json::json!({"owner": owner, "index": index, "state": state}));
}

fn new_transfer(heir: &AccountId, asset: Asset, destination: String, amount: u128) -> Transfer {
    Transfer {
        heir: heir.clone(),
        asset,
        destination,
        amount: U128(amount),
        state: TransferState::Pending,
        eth_tx: None,
        signature: None,
        signed_versions: vec![],
        attempts: 0,
        tx_hash: None,
        failure: None,
    }
}

impl Contract {
    /// Current-layout copy of a plan, converting a v0.1 plan without writing.
    fn read_plan(&self, owner: &AccountId) -> Option<Plan> {
        match self.plans.get(owner) {
            Some(p) => Some(p.clone()),
            None => self.legacy_plans.get(owner).cloned().map(Plan::from),
        }
    }

    /// Moves a v0.1 plan into the current layout (storage stays with the contract).
    fn migrate_plan(&mut self, owner: &AccountId) {
        if !self.plans.contains_key(owner) {
            if let Some(old) = self.legacy_plans.remove(owner) {
                self.plans.insert(owner.clone(), old.into());
            }
        }
    }

    fn plan_ref(&self, owner: &AccountId) -> Plan {
        self.read_plan(owner).unwrap_or_else(|| fail(Error::NoPlan))
    }

    fn plan_mut(&mut self, owner: &AccountId) -> &mut Plan {
        self.migrate_plan(owner);
        self.plans.get_mut(owner).unwrap_or_else(|| fail(Error::NoPlan))
    }

    fn close_if_settled(&mut self, owner: &AccountId) {
        let settled = self
            .read_plan(owner)
            .and_then(|p| p.proposal)
            .is_some_and(|p| p.transfers.iter().all(|t| t.state == TransferState::Confirmed));
        if settled {
            let unused = ft_reserve(owner);
            if unused > 0 {
                set_ft_reserve(owner, 0);
                let plan = self.plan_mut(owner);
                plan.escrow = U128(plan.escrow.0 + unused);
            }
            self.open_releases.remove(owner);
            emit("release_settled", near_sdk::serde_json::json!({"owner": owner}));
        }
    }

    /// A proposal transfer, or the owner's vault withdrawal for VAULT_WITHDRAWAL.
    fn tr_read(&self, owner: &AccountId, index: u32) -> Option<Transfer> {
        if index == VAULT_WITHDRAWAL {
            return read_withdrawal(owner);
        }
        self.read_plan(owner)?.proposal?.transfers.get(index as usize).cloned()
    }

    fn tr_get(&self, owner: &AccountId, index: u32) -> Transfer {
        if index != VAULT_WITHDRAWAL {
            let plan = self.plan_ref(owner);
            let p = plan.proposal.as_ref().unwrap_or_else(|| fail(Error::NoProposal));
            return p.transfers.get(index as usize).cloned().unwrap_or_else(|| fail(Error::BadIndex));
        }
        read_withdrawal(owner).unwrap_or_else(|| fail(Error::NoWithdrawal))
    }

    fn tr_put(&mut self, owner: &AccountId, index: u32, tr: Transfer) {
        if index == VAULT_WITHDRAWAL {
            write_withdrawal(owner, &tr);
        } else {
            *self.transfer_mut(owner, index) = tr;
        }
    }

    fn transfer_mut(&mut self, owner: &AccountId, index: u32) -> &mut Transfer {
        let plan = self.plan_mut(owner);
        let p = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal));
        p.transfers.get_mut(index as usize).unwrap_or_else(|| fail(Error::BadIndex))
    }

    fn assert_executor(&self) {
        if !self.executors.contains(&caller()) {
            fail(Error::Unauthorized);
        }
    }

    /// T1a: mark in flight, then transfer NEAR from escrow to the fixed destination.
    /// T1a for NEAR and NEP-141. A token transfer first registers the heir with
    /// the token (first attempt only, paid from the proposal's registration
    /// reserve; already-registered accounts get it refunded to this contract).
    fn send_near(&mut self, owner: &AccountId, index: usize) -> Promise {
        let deposits: Vec<Nep141Token> = nep141_tokens();
        let tr = self.transfer_mut(owner, index as u32);
        tr.state = TransferState::Sending;
        tr.failure = None;
        let first = tr.attempts == 0;
        let asset = tr.asset.clone();
        if matches!(asset, Asset::Nep141(_)) {
            tr.attempts += 1;
        }
        let dest: AccountId = tr.destination.parse().unwrap_or_else(|_| fail(Error::BadDestination));
        let amount = tr.amount.0;
        let send = match asset {
            Asset::Nep141(token) => {
                let fee = deposits.iter().find(|t| t.account_id == token).map(|t| t.storage_deposit.0).unwrap_or(0);
                let reserve = ft_reserve(owner);
                let transfer = ft_transfer(&token, &dest, amount, "Behest release");
                if first && fee > 0 && reserve >= fee {
                    set_ft_reserve(owner, reserve - fee);
                    Promise::new(token)
                        .function_call(
                            "storage_deposit",
                            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"account_id": dest, "registration_only": true})).expect("json"),
                            NearToken::from_yoctonear(fee),
                            FT_GAS,
                        )
                        .then(transfer)
                } else {
                    transfer
                }
            }
            _ => Promise::new(dest).transfer(NearToken::from_yoctonear(amount)),
        };
        send.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_near_transfer(owner.clone(), index as u32),
        )
    }

    /// T1b / T6: build the exact transaction from the snapshot and ask the MPC
    /// network to sign its hash. The nonce is assigned once and never changes;
    /// only the fees move on retry, bounded by the cap.
    /// T3 for Bitcoin. The reported txid must be a version this contract
    /// built. The current one needs a signed transfer; a replaced version is
    /// already on the network (the executor saw it spend the inputs), so it is
    /// adopted from any unsettled state: it becomes the current version, the
    /// release head moves to its change, and later payouts that spent the
    /// bumped version's change are reset to be signed again from there.
    fn report_btc_broadcast(&mut self, owner: &AccountId, index: u32, mut tr: Transfer, txid: String) {
        let pid = self.btx_pid(owner, index);
        let cur = read_btx(owner, index, pid).unwrap_or_else(|| fail(Error::InvalidTransferState));
        if cur.txid == txid && cur.raw.is_some() {
            if !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
                fail(Error::InvalidTransferState);
            }
        } else {
            if tr.state == TransferState::Confirmed {
                fail(Error::InvalidTransferState);
            }
            let mut versions = read_btx_versions(owner, index, pid);
            let at = versions.iter().position(|v| v.txid == txid).unwrap_or_else(|| fail(Error::InvalidTransferState));
            let old = versions.remove(at);
            if cur.raw.is_some() && !versions.iter().any(|v| v.txid == cur.txid) {
                versions.push(cur.clone());
            }
            write_btx_versions(owner, index, pid, &versions);
            write_btx(owner, index, pid, &old);
            if let Some(id) = pid {
                let mut rel = read_btc_release(owner).unwrap_or_else(|| fail(Error::NoProposal));
                let transfers = self.plan_ref(owner).proposal.map(|p| p.transfers).unwrap_or_default();
                let mut reset = vec![];
                for (j, t) in transfers.iter().enumerate() {
                    let j = j as u32;
                    if j == index || !t.asset.is_btc() {
                        continue;
                    }
                    if read_btx(owner, j, Some(id)).is_some_and(|b| b.seq > old.seq) {
                        if t.state == TransferState::Confirmed {
                            fail(Error::InvalidTransferState);
                        }
                        reset.push(j);
                    }
                }
                for j in &reset {
                    remove_btx(owner, *j, Some(id));
                    let mut t = self.tr_get(owner, *j);
                    t.state = TransferState::Failed;
                    t.failure = Some("Rechained".into());
                    t.tx_hash = None;
                    self.tr_put(owner, *j, t);
                    emit_transfer(owner, *j, TransferState::Failed);
                }
                rel.signed = old.seq + 1;
                rel.last = Some(index);
                rel.head = btc_change(&old);
                write_btc_release(owner, &rel);
            }
            emit("btc_version_adopted", near_sdk::serde_json::json!({"owner": owner, "index": index, "txid": txid}));
            tr.failure = None;
        }
        tr.tx_hash = Some(txid);
        tr.state = TransferState::Broadcast;
        self.tr_put(owner, index, tr);
        emit_transfer(owner, index, TransferState::Broadcast);
    }

    fn btx_pid(&self, owner: &AccountId, index: u32) -> Option<u64> {
        if index == VAULT_WITHDRAWAL {
            None
        } else {
            Some(self.plan_ref(owner).proposal.unwrap_or_else(|| fail(Error::NoProposal)).id)
        }
    }

    /// T2 for Bitcoin (D20). A first signing spends the release's current
    /// head (the reported coins, or the previous payout's change) and moves
    /// the head to this payout's change. A re-sign keeps the inputs and the
    /// heir's output: after a signing failure it is identical (same txid, so
    /// later payouts stay valid); after a network failure it bumps the fee out
    /// of the change, allowed only for the latest payout (nothing spends its
    /// change yet).
    fn sign_btc(&mut self, owner: &AccountId, index: usize) -> Promise {
        let idx = index as u32;
        let cfg = btc_config();
        let pubkey = btc_pubkey(owner).unwrap_or_else(|| fail(Error::BtcVaultUnknown));
        let pkh = btc::hash160(&pubkey);
        let mut tr = self.tr_get(owner, idx);
        let pid = self.btx_pid(owner, idx);
        let existing = read_btx(owner, idx, pid);
        let dest = btc::address_script(&tr.destination).unwrap_or_else(|| fail(Error::InvalidBtcAddress));
        let amount = tr.amount.0 as u64;
        let mut rel = pid.map(|_| read_btc_release(owner).unwrap_or_else(|| fail(Error::NoProposal)));
        // later payouts that still need this one's change
        let waiting = match pid {
            Some(id) => self
                .plan_ref(owner)
                .proposal
                .map(|p| p.transfers.iter().enumerate().filter(|(i, t)| t.asset.is_btc() && *i != index && read_btx(owner, *i as u32, Some(id)).is_none()).count())
                .unwrap_or(0),
            None => 0,
        };
        let (inputs, seq, rate, fresh) = match &existing {
            // already built: same tx again after a signing failure
            Some(b) if b.raw.is_none() && !b.outputs.is_empty() => (b.inputs.clone(), b.seq, b.fee_rate, false),
            // signed before and failed on the network: bump, latest payout only
            Some(b) if b.raw.is_some() => {
                if let Some(r) = &rel {
                    if r.last != Some(idx) {
                        fail(Error::BtcNotHead);
                    }
                }
                let bumped = (b.fee_rate + 1).max(b.fee_rate * 5 / 4).min(cfg.max_fee_rate);
                if bumped <= b.fee_rate {
                    fail(Error::FeeAtCap);
                }
                // It may already be in a mempool or a block: keep it so the
                // executor can still recognise and report it.
                let mut v = read_btx_versions(owner, idx, pid);
                if !v.iter().any(|x| x.txid == b.txid) {
                    v.push(b.clone());
                    write_btx_versions(owner, idx, pid, &v);
                }
                (b.inputs.clone(), b.seq, bumped, false)
            }
            // owner withdrawal draft
            Some(b) => (b.inputs.clone(), 0, cfg.fee_rate, false),
            None => {
                let r = rel.as_ref().expect("release payout");
                if r.head.is_empty() {
                    fail(Error::InvalidUtxos);
                }
                (r.head.clone(), r.signed, cfg.fee_rate, true)
            }
        };
        let (n, total) = check_utxos(&inputs);
        let parsed = to_tx(&BtcTx { inputs: inputs.clone(), outputs: vec![], fee_rate: 0, fee: U64(0), seq: 0, txid: String::new(), sighashes: vec![], signatures: vec![], raw: None }).inputs;
        let change_script = btc::p2wpkh_script(&pkh);
        let with = btc::vsize(n, &[dest.len(), change_script.len()]) * rate;
        let without = btc::vsize(n, &[dest.len()]) * rate;
        let mut outputs = vec![btc::Output { script: dest, value: amount }];
        let (fee, change) = if total >= amount + with + btc::DUST {
            let change = total - amount - with;
            outputs.push(btc::Output { script: change_script, value: change });
            (with, change)
        } else if waiting == 0 && total >= amount + without {
            (total - amount, 0)
        } else {
            fail(Error::InsufficientFeeReserve)
        };
        let tx = btc::Tx { inputs: parsed, outputs };
        let txid = eth::hex_encode(&tx.txid());
        let sighashes: Vec<String> = (0..n).map(|i| eth::hex_encode(&tx.sighash(i, &pkh))).collect();
        let b = BtcTx {
            inputs,
            outputs: tx.outputs.iter().map(|o| BtcOutput { script: eth::hex_encode(&o.script), value: U64(o.value) }).collect(),
            fee_rate: rate,
            fee: U64(fee),
            seq,
            txid: txid.clone(),
            sighashes: sighashes.clone(),
            signatures: vec![],
            raw: None,
        };
        write_btx(owner, idx, pid, &b);
        if let Some(r) = rel.as_mut() {
            if fresh {
                r.signed += 1;
            }
            if fresh || r.last == Some(idx) {
                r.last = Some(idx);
                r.head = if change > 0 { vec![BtcUtxo { txid, vout: 1, value: U64(change) }] } else { vec![] };
            }
            write_btc_release(owner, r);
        }
        tr.state = TransferState::Signing;
        tr.failure = None;
        tr.tx_hash = None;
        tr.attempts += 1;
        let attempt = tr.attempts;
        self.tr_put(owner, idx, tr);

        let path = btc_vault_path(owner);
        let mut all: Option<Promise> = None;
        for h in sighashes {
            let p = mpc::ext(self.mpc_contract.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(MPC_SIGN_GAS)
                .sign(SignRequestArgs { payload_v2: SignPayload::Ecdsa(h), path: path.clone(), domain_id: MPC_DOMAIN_SECP256K1 });
            all = Some(match all {
                None => p,
                Some(q) => q.and(p),
            });
        }
        all.expect("at least one input")
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_btc_signed(owner.clone(), idx, attempt))
    }

    fn sign_eth(&mut self, owner: &AccountId, index: usize) -> Promise {
        let chain_id = self.eth_chain_id;
        let configured_gas = self.eth_gas_limit;
        let cap = self.eth_max_fee_cap.0;
        let initial = self.eth_initial_max_fee.0.min(cap);
        let priority = self.eth_priority_fee.0;
        let mpc_contract = self.mpc_contract.clone();

        let idx = index as u32;
        let mut owned = self.tr_get(owner, idx);
        let plan = self.plan_mut(owner);
        let next_nonce = plan.eth_next_nonce;
        // A withdrawal has no proposal snapshot: it uses the current limit.
        let snapshot_gas = if idx == VAULT_WITHDRAWAL {
            configured_gas
        } else {
            plan.proposal.as_ref().unwrap_or_else(|| fail(Error::NoProposal)).eth_gas_limit
        };
        let tr = &mut owned;
        // A re-sign keeps the nonce, so at most one version can be mined; it may
        // raise the gas limit to the configured one (fixes "GasLimitTooLow").
        let (nonce, max_fee, prio_fee, gas_limit, fresh) = match &tr.eth_tx {
            None => (next_nonce, initial, priority.min(initial), snapshot_gas, true),
            Some(prev) => {
                let max_fee = eth::bump(prev.max_fee_per_gas.0, cap);
                let gas = prev.gas_limit.max(configured_gas);
                (prev.nonce, max_fee, eth::bump(prev.max_priority_fee_per_gas.0, max_fee), gas, false)
            }
        };
        let (to, value, data) = evm_call(tr).unwrap_or_else(|| fail(Error::BadDestination));
        let hash = eth::EthTransfer {
            chain_id,
            nonce,
            max_priority_fee_per_gas: prio_fee,
            max_fee_per_gas: max_fee,
            gas_limit,
            to: &to,
            value,
            data: &data,
        }
        .signing_hash();
        let payload_hash = eth::hex_encode(&hash);

        tr.eth_tx = Some(EthTxParams {
            chain_id,
            nonce,
            max_fee_per_gas: U128(max_fee),
            max_priority_fee_per_gas: U128(prio_fee),
            payload_hash: payload_hash.clone(),
            gas_limit,
        });
        tr.signature = None;
        tr.tx_hash = None;
        tr.failure = None;
        tr.state = TransferState::Signing;
        tr.attempts += 1;
        let attempt = tr.attempts;
        if fresh {
            plan.eth_next_nonce += 1;
        }
        self.tr_put(owner, idx, owned);

        mpc::ext(mpc_contract)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(MPC_SIGN_GAS)
            .sign(SignRequestArgs {
                payload_v2: SignPayload::Ecdsa(payload_hash),
                path: eth_vault_path(owner),
                domain_id: MPC_DOMAIN_SECP256K1,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_eth_signed(owner.clone(), index as u32, attempt),
            )
    }

    fn assert_admin(&self) {
        if caller() != self.admin {
            fail(Error::Unauthorized);
        }
    }

    fn charge_storage(&self, before: u64, payer: &AccountId) {
        let used = env::storage_usage().saturating_sub(before) as u128;
        let cost = used * STORAGE_BYTE_COST;
        let attached = env::attached_deposit().as_yoctonear();
        if attached < cost {
            fail(Error::InsufficientDeposit);
        }
        let refund = attached - cost;
        if refund > 0 {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(refund)).detach();
        }
    }

    fn cancel_inner(&mut self, owner: &AccountId) {
        let t = now();
        let plan = self.plan_mut(owner);
        let p = plan.proposal.as_ref().unwrap_or_else(|| fail(Error::NoProposal));
        if let Some(end) = p.waiting_ends_at_ms {
            if t >= end {
                fail(Error::CancelWindowClosed);
            }
        }
        let id = p.id;
        self.unwind_proposal(owner);
        emit("release_cancelled", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id}));
    }

    /// Drops an unexecuted proposal and returns everything it reserved: NEAR
    /// and NEP-141 shares to escrow, the token-registration reserve, and the
    /// Bitcoin release record. Shared by cancel (P7) and rejection (P6).
    fn unwind_proposal(&mut self, owner: &AccountId) {
        let plan = self.plan_mut(owner);
        let p = plan.proposal.take().unwrap_or_else(|| fail(Error::NoProposal));
        let reserved: u128 = p.transfers.iter().filter(|x| x.asset == Asset::Near).map(|x| x.amount.0).sum();
        plan.escrow = U128(plan.escrow.0 + reserved + ft_reserve(owner));
        set_ft_reserve(owner, 0);
        env::storage_remove(&btc_release_key(owner));
        env::storage_remove(&fixed_round_key(owner));
        env::storage_remove(&snapshot_key(owner));
        for x in &p.transfers {
            if let Asset::Nep141(t) = &x.asset {
                set_ft_escrow(t, owner, ft_escrow(t, owner) + x.amount.0);
            }
        }
        self.open_releases.remove(owner);
    }

    /// D21. A settled release (every transfer confirmed) is moved to the
    /// plan's release history, so the plan can check in, take deposits and
    /// run a follow-up round. Its fixed amounts are recorded as paid.
    fn archive_settled(&mut self, owner: &AccountId) -> bool {
        let settled = self.read_plan(owner).and_then(|p| p.proposal).is_some_and(|p| p.waiting_ends_at_ms.is_some() && p.transfers.iter().all(|t| t.state == TransferState::Confirmed));
        if !settled {
            return false;
        }
        let p = self.plan_mut(owner).proposal.take().expect("checked");
        let mut paid = read_fixed_paid(owner);
        let round: Vec<FixedAmount> = env::storage_read(&fixed_round_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default();
        for f in round {
            match paid.iter_mut().find(|d| d.heir == f.heir && d.asset == f.asset) {
                Some(d) => d.amount = U128(d.amount.0 + f.amount.0),
                None => paid.push(f),
            }
        }
        env::storage_write(&fixed_paid_key(owner), &near_sdk::borsh::to_vec(&paid).expect("borsh"));
        env::storage_remove(&fixed_round_key(owner));
        env::storage_remove(&btc_release_key(owner));
        env::storage_remove(&snapshot_key(owner));
        let id = p.id;
        let mut hist = read_history(owner);
        hist.push(p);
        if hist.len() > MAX_HISTORY {
            hist.remove(0);
        }
        env::storage_write(&history_key(owner), &near_sdk::borsh::to_vec(&hist).expect("borsh"));
        self.open_releases.remove(owner);
        emit("release_archived", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id}));
        true
    }

    fn vote(&mut self, owner: AccountId, proposal_id: u64, approve: bool) {
        let g = caller();
        let t = now();
        let plan = self.plan_mut(&owner);
        if !plan.policy.guardians.contains(&g) {
            fail(Error::NotGuardian);
        }
        let quorum = plan.policy.quorum as usize;
        let guardian_count = plan.policy.guardians.len();
        let waiting = plan.policy.waiting_period_ms;
        let p = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal));
        if p.id != proposal_id || p.approved_at_ms.is_some() {
            fail(Error::NotProposed);
        }
        if p.approvals.contains(&g) || p.rejections.contains(&g) {
            fail(Error::AlreadyVoted);
        }

        if approve {
            p.approvals.push(g.clone());
            if p.approvals.len() >= quorum {
                p.approved_at_ms = Some(t);
                p.waiting_ends_at_ms = Some(t + waiting);
                emit(
                    "release_approved",
                    near_sdk::serde_json::json!({"owner": owner, "proposal_id": proposal_id, "waiting_ends_at_ms": t + waiting}),
                );
            }
        } else {
            p.rejections.push(g.clone());
            if guardian_count - p.rejections.len() < quorum {
                self.unwind_proposal(&owner);
                emit("release_rejected", near_sdk::serde_json::json!({"owner": owner, "proposal_id": proposal_id}));
                return;
            }
        }
        emit(
            "release_vote",
            near_sdk::serde_json::json!({"owner": owner, "proposal_id": proposal_id, "guardian": g, "approve": approve}),
        );
    }
}
