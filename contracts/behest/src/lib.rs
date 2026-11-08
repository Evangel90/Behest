//! Behest contract: MVP plan lifecycle.
//!
//! Spec: docs/stage0. Each public method notes its transition id from
//! 01-state-machine.md (P1..P10, T1..T6).

mod errors;
pub mod eth;
mod legacy;
mod policy;
mod types;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
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
        // Existing release rules must still fit the new heirs and guardians.
        if let Some(r) = read_rules(&owner) {
            policy::validate_rules(&owner, &policy, r);
        }
        self.migrate_plan(&owner);
        let storage_before = env::storage_usage();

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
        match rules {
            Some(r) => {
                let r = policy::validate_rules(&owner, &plan.policy, r);
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
        let receives = |r: &&Recipient| dest_for(r, &tr.asset).is_some();
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
        let dest = dest_for(&next, &tr.asset).expect("filtered");
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
        match self.read_plan(&owner) {
            Some(plan) if plan.proposal.is_none() => {}
            _ => return PromiseOrValue::Value(amount),
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
            Asset::Near | Asset::Nep141(_) => fail(Error::BadAsset),
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
    pub fn cancel_vault_withdrawal(&mut self, owner: AccountId) -> Promise {
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
        w.asset = Asset::Eth;
        w.amount = U128(0);
        w.signed_versions.clear();
        write_withdrawal(&owner, &w);
        emit("vault_withdrawal_cancelled", near_sdk::serde_json::json!({"owner": owner, "nonce": w.eth_tx.as_ref().map(|t| t.nonce)}));
        self.sign_eth(&owner, VAULT_WITHDRAWAL as usize)
    }

    // ------------------------------------------------------------- guardian

    /// P4. A guardian opens a release once the owner is overdue.
    /// `eth_balance` and `erc20_balances` are the vault balances observed by
    /// the proposer (D5). Guardians approve the resulting transfer list.
    pub fn propose_release(&mut self, owner: AccountId, eth_balance: Option<U128>, erc20_balances: Option<Vec<TokenBalance>>) -> u64 {
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
        let plan = self.plan_mut(&owner);
        if !plan.policy.guardians.contains(&g) {
            fail(Error::NotGuardian);
        }
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
        let rules = read_rules(&owner).unwrap_or_default();
        let pol = plan.policy.clone();
        let near_ok = |i: usize| pol.heirs[i].near_destination.is_some();
        let eth_ok = |i: usize| pol.heirs[i].eth_destination.is_some();
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
        let near_split = policy::split(near_total, &pol, &rules, &Asset::Near, near_ok);
        let ft_splits: Vec<Vec<u128>> = ft_snap.iter().map(|(t, b)| policy::split(*b, &pol, &rules, &Asset::Nep141(t.clone()), near_ok)).collect();
        let eth_split = policy::split(eth_total, &pol, &rules, &Asset::Eth, eth_ok);
        let erc_splits: Vec<Vec<u128>> = tokens.iter().map(|(t, b)| policy::split(*b, &pol, &rules, &Asset::Erc20(t.clone()), eth_ok)).collect();
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
        emit("release_proposed", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id, "proposer": g}));
        self.vote(owner, id, true);
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

        let mine: Vec<(usize, bool)> = p
            .transfers
            .iter()
            .enumerate()
            .filter(|(_, tr)| tr.heir == heir)
            .filter(|(_, tr)| match tr.asset {
                // NEAR: start or retry. ETH: first attempt only; ETH retries
                // go through `retry_transfer` so the fee bump is explicit.
                Asset::Near | Asset::Nep141(_) => matches!(tr.state, TransferState::Pending | TransferState::Failed),
                Asset::Eth | Asset::Erc20(_) => tr.state == TransferState::Pending,
            })
            .map(|(i, tr)| (i, tr.asset.is_evm()))
            .collect();

        let started = mine.len() as u32;
        for (i, evm) in mine {
            if evm { self.sign_eth(&owner, i) } else { self.send_near(&owner, i) }.detach();
        }
        started
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
        if tr.asset.is_evm() {
            self.sign_eth(&owner, index as usize)
        } else {
            self.send_near(&owner, index as usize)
        }
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
        if !tr.asset.is_evm() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
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
        if !tr.asset.is_evm() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
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

    /// Re-issue an ETH transfer whose transaction was mined but reverted, on a
    /// fresh nonce with the current gas limit and starting fees.
    ///
    /// Trust assumption (05-threat-model): the contract cannot see Ethereum, so
    /// it relies on the admin having checked the revert on-chain. Without that
    /// check a still-pending original could be mined alongside the re-issue.
    pub fn reissue_reverted_transfer(&mut self, owner: AccountId, index: u32) -> Promise {
        self.assert_admin();
        let gas_limit = self.eth_gas_limit;
        let plan = self.plan_mut(&owner);
        let next_nonce = plan.eth_next_nonce;
        let p = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal));
        let tr = p.transfers.get_mut(index as usize).unwrap_or_else(|| fail(Error::BadIndex));
        if !tr.asset.is_evm() || tr.state != TransferState::Failed || tr.failure.as_deref() != Some("Reverted") {
            fail(Error::InvalidTransferState);
        }
        let old_nonce = tr.eth_tx.as_ref().map(|t| t.nonce);
        tr.eth_tx = None; // sign_eth assigns the next nonce and initial fees
        p.eth_gas_limit = p.eth_gas_limit.max(gas_limit);
        emit(
            "transfer_reissued",
            near_sdk::serde_json::json!({"owner": owner, "index": index, "old_nonce": old_nonce, "new_nonce": next_nonce}),
        );
        self.sign_eth(&owner, index as usize)
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

fn read_withdrawal(owner: &AccountId) -> Option<Transfer> {
    env::storage_read(&withdrawal_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

/// Unresolved: not yet confirmed, and not a mined revert (whose nonce is used).
fn withdrawal_busy(w: &Option<Transfer>) -> bool {
    w.as_ref().is_some_and(|t| t.state != TransferState::Confirmed && !(t.state == TransferState::Failed && t.failure.as_deref() == Some("Reverted")))
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

fn rules_key(owner: &AccountId) -> Vec<u8> {
    [b"rules:".as_slice(), owner.as_bytes()].concat()
}

fn read_rules(owner: &AccountId) -> Option<ReleaseRules> {
    env::storage_read(&rules_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

/// Where `r` receives `asset`: its NEAR account or its Ethereum address.
fn dest_for(r: &Recipient, asset: &Asset) -> Option<String> {
    if asset.is_evm() {
        r.eth_destination.clone()
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
        Asset::Near | Asset::Nep141(_) => None,
    }
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
        let reserved: u128 = p.transfers.iter().filter(|x| x.asset == Asset::Near).map(|x| x.amount.0).sum();
        let tokens: Vec<(AccountId, u128)> = p
            .transfers
            .iter()
            .filter_map(|x| match &x.asset {
                Asset::Nep141(t) => Some((t.clone(), x.amount.0)),
                _ => None,
            })
            .collect();
        plan.escrow = U128(plan.escrow.0 + reserved + ft_reserve(owner));
        plan.proposal = None;
        set_ft_reserve(owner, 0);
        for (token, amount) in tokens {
            set_ft_escrow(&token, owner, ft_escrow(&token, owner) + amount);
        }
        self.open_releases.remove(owner);
        emit("release_cancelled", near_sdk::serde_json::json!({"owner": owner, "proposal_id": id}));
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
                let reserved: u128 = p.transfers.iter().filter(|x| x.asset == Asset::Near).map(|x| x.amount.0).sum();
                plan.escrow = U128(plan.escrow.0 + reserved);
                plan.proposal = None;
                self.open_releases.remove(&owner);
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
