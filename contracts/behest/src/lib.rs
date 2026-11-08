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
use near_sdk::{env, ext_contract, log, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

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
        if plan.proposal.is_some() {
            fail(Error::ProposalOpen);
        }
        if amount.0 > plan.escrow.0 {
            fail(Error::InsufficientEscrow);
        }
        plan.escrow = U128(plan.escrow.0 - amount.0);
        emit("withdraw", near_sdk::serde_json::json!({"owner": owner, "amount": amount}));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ------------------------------------------------------------- guardian

    /// P4. A guardian opens a release once the owner is overdue.
    /// `eth_balance` and `erc20_balances` are the vault balances observed by
    /// the proposer (D5). Guardians approve the resulting transfer list.
    pub fn propose_release(&mut self, owner: AccountId, eth_balance: Option<U128>, erc20_balances: Option<Vec<TokenBalance>>) -> u64 {
        let g = caller();
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

        let near_total = plan.escrow.0;
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

        let mut transfers = Vec::new();
        let mut near_reserved = 0u128;
        for h in &plan.policy.heirs {
            if let Some(dest) = &h.near_destination {
                let amount = policy::share_of(near_total, h.share_bps);
                if amount > 0 {
                    near_reserved += amount;
                    transfers.push(new_transfer(&h.account_id, Asset::Near, dest.to_string(), amount));
                }
            }
            if let Some(dest) = &h.eth_destination {
                let amount = policy::share_of(eth_total, h.share_bps);
                if amount > 0 {
                    transfers.push(new_transfer(&h.account_id, Asset::Eth, dest.clone(), amount));
                }
                for (token, balance) in &tokens {
                    let amount = policy::share_of(*balance, h.share_bps);
                    if amount > 0 {
                        transfers.push(new_transfer(&h.account_id, Asset::Erc20(token.clone()), dest.clone(), amount));
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
        if !plan.policy.heirs.iter().any(|h| h.account_id == heir) {
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
                Asset::Near => matches!(tr.state, TransferState::Pending | TransferState::Failed),
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
        let tr = self.transfer_mut(&owner, index);
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
        let tr = self.transfer_mut(&owner, index);
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
        emit_transfer(&owner, index, state);
    }

    // ------------------------------------------------------------- executor

    /// T3. Executor reports the hash of the broadcast signed transaction.
    pub fn report_broadcast(&mut self, owner: AccountId, index: u32, tx_hash: String) {
        self.assert_executor();
        let tr = self.transfer_mut(&owner, index);
        if !tr.asset.is_evm() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
            fail(Error::InvalidTransferState);
        }
        tr.tx_hash = Some(tx_hash);
        tr.state = TransferState::Broadcast;
        emit_transfer(&owner, index, TransferState::Broadcast);
    }

    /// T4. Executor reports inclusion with the required confirmations.
    pub fn report_confirmed(&mut self, owner: AccountId, index: u32, tx_hash: String) {
        self.assert_executor();
        let tr = self.transfer_mut(&owner, index);
        if tr.state == TransferState::Confirmed && tr.tx_hash.as_deref() == Some(tx_hash.as_str()) {
            return;
        }
        if tr.state != TransferState::Broadcast || tr.tx_hash.as_deref() != Some(tx_hash.as_str()) {
            fail(Error::InvalidTransferState);
        }
        tr.state = TransferState::Confirmed;
        emit_transfer(&owner, index, TransferState::Confirmed);
        self.close_if_settled(&owner);
    }

    /// T5. Executor reports a failure (reason code, e.g. FeeAboveCap, NonceGap, Dropped).
    pub fn report_failed(&mut self, owner: AccountId, index: u32, reason: String) {
        self.assert_executor();
        let tr = self.transfer_mut(&owner, index);
        if !tr.asset.is_evm() || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
            fail(Error::InvalidTransferState);
        }
        tr.state = TransferState::Failed;
        tr.failure = Some(reason.chars().take(64).collect());
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
            plan,
        })
    }

    /// Raw signed transaction (`0x…`) for a `Signed`/`Broadcast` ETH transfer.
    /// Anyone can broadcast it; the executor is a convenience, not an authority.
    pub fn get_signed_tx(&self, owner: AccountId, index: u32) -> Option<String> {
        let plan = self.read_plan(&owner)?;
        let tr = plan.proposal.as_ref()?.transfers.get(index as usize)?;
        raw_signed_tx(tr, tr.eth_tx.as_ref()?, tr.signature.as_ref()?)
    }

    /// Every signed version of an ETH transfer (oldest first), as raw `0x…`
    /// transactions. They share one nonce, so at most one can be mined.
    pub fn get_signed_tx_versions(&self, owner: AccountId, index: u32) -> Vec<String> {
        let plan = self.read_plan(&owner);
        let Some(tr) = plan.as_ref().and_then(|p| p.proposal.as_ref()).and_then(|p| p.transfers.get(index as usize)) else {
            return vec![];
        };
        tr.signed_versions.iter().filter_map(|v| raw_signed_tx(tr, &v.eth_tx, &v.signature)).collect()
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
        Asset::Near => None,
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
            self.open_releases.remove(owner);
            emit("release_settled", near_sdk::serde_json::json!({"owner": owner}));
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
    fn send_near(&mut self, owner: &AccountId, index: usize) -> Promise {
        let tr = self.transfer_mut(owner, index as u32);
        tr.state = TransferState::Sending;
        tr.failure = None;
        let dest: AccountId = tr.destination.parse().unwrap_or_else(|_| fail(Error::BadDestination));
        let amount = NearToken::from_yoctonear(tr.amount.0);
        Promise::new(dest).transfer(amount).then(
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

        let plan = self.plan_mut(owner);
        let next_nonce = plan.eth_next_nonce;
        let proposal = plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal));
        let snapshot_gas = proposal.eth_gas_limit;
        let tr = &mut proposal.transfers[index];
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
        plan.escrow = U128(plan.escrow.0 + reserved);
        plan.proposal = None;
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
