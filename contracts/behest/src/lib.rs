//! Behest contract: MVP plan lifecycle.
//!
//! Spec: docs/stage0. Each public method notes its transition id from
//! 01-state-machine.md (P1..P10, T1..T6).

mod errors;
pub mod eth;
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
const ETH_TRANSFER_GAS: u128 = eth::GAS_LIMIT;
/// MPC `sign` requires 15 Tgas attached on testnet (config v3.18); keep headroom.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
const MPC_DOMAIN_SECP256K1: u32 = 0;
const MAX_MPC_RESPONSE_BYTES: usize = 1024;
/// Fee bumps stop at the cap, so distinct versions are few; the oldest is dropped beyond this.
const MAX_SIGNED_VERSIONS: usize = 32;

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
    Plans,
    Executors,
    OpenReleases,
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
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub admin: AccountId,
    pub mpc_contract: AccountId,
    pub eth_chain_id: u64,
    pub eth_max_fee_cap: U128,
    pub eth_initial_max_fee: U128,
    pub eth_priority_fee: U128,
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
    pub fn new(
        admin: AccountId,
        mpc_contract: AccountId,
        eth_chain_id: u64,
        eth_max_fee_cap: U128,
        eth_initial_max_fee: U128,
        eth_priority_fee: U128,
    ) -> Self {
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
            plans: LookupMap::new(StorageKey::Plans),
        }
    }

    // ---------------------------------------------------------------- owner

    /// P1 create / P2 replace. Attach enough NEAR to cover storage growth;
    /// the excess is refunded. Replacing counts as a check-in.
    #[payable]
    pub fn set_plan(&mut self, plan: PlanInput) {
        let owner = caller();
        let policy = policy::validate(&owner, plan);
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
    /// `eth_balance` is the vault balance observed by the proposer (D5).
    pub fn propose_release(&mut self, owner: AccountId, eth_balance: Option<U128>) -> u64 {
        let g = caller();
        let fee_cap = self.eth_max_fee_cap.0;
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
        let fee_reserve = eth_heirs * ETH_TRANSFER_GAS * fee_cap;
        if eth_heirs > 0 && eth_balance > 0 && eth_balance <= fee_reserve {
            fail(Error::InsufficientFeeReserve);
        }
        let eth_total = eth_balance.saturating_sub(fee_reserve);

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
            eth_fee_reserve: U128(if eth_balance > 0 { fee_reserve } else { 0 }),
            transfers,
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

        let mine: Vec<(usize, Asset)> = p
            .transfers
            .iter()
            .enumerate()
            .filter(|(_, tr)| tr.heir == heir)
            .filter(|(_, tr)| match tr.asset {
                // NEAR: start or retry. ETH: first attempt only; ETH retries
                // go through `retry_transfer` so the fee bump is explicit.
                Asset::Near => matches!(tr.state, TransferState::Pending | TransferState::Failed),
                Asset::Eth => tr.state == TransferState::Pending,
            })
            .map(|(i, tr)| (i, tr.asset))
            .collect();

        let started = mine.len() as u32;
        for (i, asset) in mine {
            match asset {
                Asset::Near => self.send_near(&owner, i),
                Asset::Eth => self.sign_eth(&owner, i),
            }
            .detach();
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
        match tr.asset {
            Asset::Near => self.send_near(&owner, index as usize),
            Asset::Eth => self.sign_eth(&owner, index as usize),
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
        if tr.asset != Asset::Eth || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
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
        if tr.asset != Asset::Eth || !matches!(tr.state, TransferState::Signed | TransferState::Broadcast) {
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

    pub fn set_eth_fees(&mut self, max_fee_cap: U128, initial_max_fee: U128, priority_fee: U128) {
        self.assert_admin();
        self.eth_max_fee_cap = max_fee_cap;
        self.eth_initial_max_fee = initial_max_fee;
        self.eth_priority_fee = priority_fee;
    }

    // ---------------------------------------------------------------- views

    pub fn get_plan(&self, owner: AccountId) -> Option<PlanView> {
        self.plans.get(&owner).map(|plan| PlanView {
            status: status_of(plan, now()),
            overdue_at_ms: overdue_at(plan),
            now_ms: now(),
            plan: plan.clone(),
        })
    }

    /// Raw signed transaction (`0x…`) for a `Signed`/`Broadcast` ETH transfer.
    /// Anyone can broadcast it; the executor is a convenience, not an authority.
    pub fn get_signed_tx(&self, owner: AccountId, index: u32) -> Option<String> {
        let tr = self.plans.get(&owner)?.proposal.as_ref()?.transfers.get(index as usize)?;
        raw_signed_tx(tr, tr.eth_tx.as_ref()?, tr.signature.as_ref()?)
    }

    /// Every signed version of an ETH transfer (oldest first), as raw `0x…`
    /// transactions. They share one nonce, so at most one can be mined.
    pub fn get_signed_tx_versions(&self, owner: AccountId, index: u32) -> Vec<String> {
        let Some(tr) = self.plans.get(&owner).and_then(|p| p.proposal.as_ref()).and_then(|p| p.transfers.get(index as usize)) else {
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

fn raw_signed_tx(tr: &Transfer, params: &EthTxParams, sig: &EthSignature) -> Option<String> {
    let to = eth::parse_address(&tr.destination)?;
    let big_r = eth::hex_decode(&sig.big_r)?;
    let tx = eth::EthTransfer {
        chain_id: params.chain_id,
        nonce: params.nonce,
        max_priority_fee_per_gas: params.max_priority_fee_per_gas.0,
        max_fee_per_gas: params.max_fee_per_gas.0,
        to: &to,
        value: tr.amount.0,
    };
    let rsv = eth::RsvSignature {
        r: big_r.get(1..33)?.try_into().ok()?,
        s: eth::hex_decode(&sig.s)?.try_into().ok()?,
        y_parity: sig.recovery_id,
    };
    Some(format!("0x{}", eth::hex_encode(&tx.signed(&rsv))))
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
    fn plan_ref(&self, owner: &AccountId) -> &Plan {
        self.plans.get(owner).unwrap_or_else(|| fail(Error::NoPlan))
    }

    fn plan_mut(&mut self, owner: &AccountId) -> &mut Plan {
        self.plans.get_mut(owner).unwrap_or_else(|| fail(Error::NoPlan))
    }

    fn close_if_settled(&mut self, owner: &AccountId) {
        let settled = self
            .plans
            .get(owner)
            .and_then(|p| p.proposal.as_ref())
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
        let cap = self.eth_max_fee_cap.0;
        let initial = self.eth_initial_max_fee.0.min(cap);
        let priority = self.eth_priority_fee.0;
        let mpc_contract = self.mpc_contract.clone();

        let plan = self.plan_mut(owner);
        let next_nonce = plan.eth_next_nonce;
        let tr = &mut plan.proposal.as_mut().unwrap_or_else(|| fail(Error::NoProposal)).transfers[index];
        let (nonce, max_fee, prio_fee, fresh) = match &tr.eth_tx {
            None => (next_nonce, initial, priority.min(initial), true),
            Some(prev) => {
                let max_fee = eth::bump(prev.max_fee_per_gas.0, cap);
                (prev.nonce, max_fee, eth::bump(prev.max_priority_fee_per_gas.0, max_fee), false)
            }
        };
        let to = eth::parse_address(&tr.destination).unwrap_or_else(|| fail(Error::BadDestination));
        let hash = eth::EthTransfer {
            chain_id,
            nonce,
            max_priority_fee_per_gas: prio_fee,
            max_fee_per_gas: max_fee,
            to: &to,
            value: tr.amount.0,
        }
        .signing_hash();
        let payload_hash = eth::hex_encode(&hash);

        tr.eth_tx = Some(EthTxParams {
            chain_id,
            nonce,
            max_fee_per_gas: U128(max_fee),
            max_priority_fee_per_gas: U128(prio_fee),
            payload_hash: payload_hash.clone(),
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
