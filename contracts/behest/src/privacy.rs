//! D33: private heir details. A sealed plan stores, instead of its heirs,
//! one commitment per heir: SHA-256 of the heir's account, share and
//! destinations with a 32-byte random salt (`commitment_text`). Who inherits,
//! how much and where stay off-chain in each heir's recovery record.
//!
//! - **Reveal.** Once the owner is overdue (and no release is open), anyone
//!   holding a record submits it with `reveal_heir`. The contract recomputes
//!   the commitment, checks the record (destinations, roles, shares never
//!   above 100% in total) and keeps it. Front-running a reveal gains
//!   nothing: funds can only go to the destinations inside the record.
//! - **Release.** `propose_release` first rebuilds the heir list from the
//!   revealed records. It waits until every heir is revealed or the reveal
//!   window (counted from when the plan became overdue) has passed. Then the
//!   unrevealed share follows the owner's rule: `Redistribute` (revealed
//!   heirs' shares are scaled up to 100%) or `Fallback` (the release rules'
//!   fallback recipient receives it). Nothing is implicit.
//! - **Re-seal.** Any sign of the owner (check-in, a delegate check-in,
//!   cancelling, saving the plan) clears the revealed list and the heir
//!   list again. What was revealed stays public in transaction history.
//! - Heir-specific release rules (fixed amounts, alternates, per-heir modes),
//!   Bitcoin destinations set apart from the record, NEAR Intents delivery
//!   and destination proofs/requests (D30/D31) need heirs in the clear, so
//!   they aren't available while a plan is sealed. The shares sum can't be
//!   checked at setup (the app checks it); the contract caps reveals at 100%.
use near_sdk::{env, near, AccountId};

use crate::changes::{self, Change};
use crate::errors::{fail, Error};
use crate::types::{BtcDestination, HeirInput, PlanInput};
use crate::*;

const MINUTE: u64 = 60_000;
const DAY: u64 = 24 * 60 * MINUTE;

#[cfg(feature = "demo-timers")]
pub const REVEAL_WINDOW: (u64, u64) = (MINUTE, 365 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const REVEAL_WINDOW: (u64, u64) = (7 * DAY, 365 * DAY);

/// What happens to the share of a heir nobody revealed in time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unrevealed {
    /// Revealed heirs' shares are scaled up to 100%.
    Redistribute,
    /// The release rules' fallback recipient receives it.
    Fallback,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedHeirs {
    /// 64 lowercase hex chars each, one per heir.
    pub commitments: Vec<String>,
    pub reveal_window_ms: u64,
    pub unrevealed: Unrevealed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PrivatePlan {
    pub plan: PlanInput,
    pub sealed: SealedHeirs,
}

/// One heir's recovery record (what the commitment hides).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HeirRecord {
    pub account_id: AccountId,
    pub share_bps: u16,
    pub near_destination: Option<AccountId>,
    /// Lowercase `0x…`.
    pub eth_destination: Option<String>,
    pub btc_destination: Option<String>,
    /// 64 hex chars (32 random bytes).
    pub salt: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RevealedHeir {
    pub index: u32,
    pub account_id: AccountId,
    pub share_bps: u16,
    pub near_destination: Option<AccountId>,
    pub eth_destination: Option<String>,
    pub btc_destination: Option<String>,
    pub revealed_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PrivateView {
    pub commitments: Vec<String>,
    pub reveal_window_ms: u64,
    pub unrevealed: Unrevealed,
    pub revealed: Vec<RevealedHeir>,
    /// When reveals open (the plan is overdue from then).
    pub reveal_opens_at_ms: u64,
    /// After this a release may go ahead without every heir revealed.
    pub reveal_deadline_ms: u64,
}

fn sealed_key(owner: &AccountId) -> Vec<u8> {
    [b"prv:".as_slice(), owner.as_bytes()].concat()
}

fn revealed_key(owner: &AccountId) -> Vec<u8> {
    [b"rvl:".as_slice(), owner.as_bytes()].concat()
}

pub fn sealed(owner: &AccountId) -> Option<SealedHeirs> {
    env::storage_read(&sealed_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

pub fn revealed(owner: &AccountId) -> Vec<RevealedHeir> {
    env::storage_read(&revealed_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn write_revealed(owner: &AccountId, v: &[RevealedHeir]) {
    if v.is_empty() {
        env::storage_remove(&revealed_key(owner));
    } else {
        env::storage_write(&revealed_key(owner), &near_sdk::borsh::to_vec(v).expect("borsh"));
    }
}

/// Switching to a public plan drops the sealed configuration.
pub fn clear(owner: &AccountId) {
    if env::storage_remove(&sealed_key(owner)) {
        env::storage_remove(&revealed_key(owner));
        emit("plan_unsealed", near_sdk::serde_json::json!({"owner": owner}));
    }
}

/// The exact text hashed into a commitment (also served by `get_heir_commitment`).
pub fn commitment_text(owner: &AccountId, r: &HeirRecord) -> String {
    format!(
        "behest-heir-v1\n{}\n{owner}\n{}\n{}\n{}\n{}\n{}\n{}",
        env::current_account_id(),
        r.account_id,
        r.share_bps,
        r.near_destination.as_ref().map(|a| a.as_str()).unwrap_or(""),
        r.eth_destination.as_deref().unwrap_or(""),
        r.btc_destination.as_deref().unwrap_or(""),
        r.salt
    )
}

pub fn commitment(owner: &AccountId, r: &HeirRecord) -> String {
    crate::eth::hex_encode(&env::sha256_array(commitment_text(owner, r).as_bytes()))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_sealed(s: &SealedHeirs) {
    let unique: std::collections::HashSet<&String> = s.commitments.iter().collect();
    if s.commitments.is_empty() || s.commitments.len() > policy::MAX_HEIRS || unique.len() != s.commitments.len() || !s.commitments.iter().all(|c| is_hex64(c)) {
        fail(Error::InvalidSealedHeirs);
    }
    if s.reveal_window_ms < REVEAL_WINDOW.0 || s.reveal_window_ms > REVEAL_WINDOW.1 {
        fail(Error::DurationOutOfBounds);
    }
}

/// Scales `v`'s shares to sum to exactly 100% (the first heir takes the rounding).
fn normalize(v: &mut [HeirInput]) {
    let total: u64 = v.iter().map(|h| h.share_bps as u64).sum();
    if total == 0 {
        fail(Error::NothingToDistribute);
    }
    for h in v.iter_mut() {
        h.share_bps = (h.share_bps as u64 * policy::TOTAL_BPS as u64 / total) as u16;
    }
    let sum: u32 = v.iter().map(|h| h.share_bps as u32).sum();
    if let Some(first) = v.iter_mut().find(|h| h.share_bps > 0) {
        first.share_bps += (policy::TOTAL_BPS - sum) as u16;
    }
}

impl Contract {
    pub(crate) fn check_private(&self, owner: &AccountId, p: PrivatePlan) -> PrivatePlan {
        check_sealed(&p.sealed);
        let policy = policy::validate_sealed(owner, p.plan, p.sealed.commitments.len());
        let cur = self.read_plan(owner);
        let before = cur.as_ref().map(|c| tier_features(owner, &c.policy));
        let mut after = tier_features(owner, &policy);
        // Hidden destinations may be on Ethereum or Bitcoin.
        after.heirs = p.sealed.commitments.len() as u8;
        after.external_assets = true;
        tiers::check(owner, before.as_ref(), &after);
        let rules = read_rules(owner);
        if let Some(r) = rules.clone() {
            policy::validate_rules(owner, &policy, r, |_| false);
        }
        if p.sealed.unrevealed == Unrevealed::Fallback && rules.as_ref().is_none_or(|r| r.fallback.is_none()) {
            fail(Error::InvalidSealedHeirs);
        }
        if let Some(o) = read_options(owner) {
            policy::validate_options(owner, &policy, o);
        }
        if let Some(g) = guardians::read_settings(owner) {
            guardians::validate_settings(owner, &policy, rules.as_ref(), g);
        }
        if !btc_dests(owner).is_empty() || intents::deliveries(owner).iter().any(|d| d.enabled) {
            fail(Error::InvalidSealedHeirs);
        }
        match cur {
            Some(c) if c.proposal.is_some() => fail(Error::ProposalOpen),
            None if self.paused => fail(Error::Paused),
            _ => PrivatePlan { plan: policy, sealed: p.sealed },
        }
    }

    pub(crate) fn write_private(&mut self, owner: &AccountId, p: PrivatePlan, check_in: bool) {
        self.write_plan(owner, p.plan, check_in);
        env::storage_write(&sealed_key(owner), &near_sdk::borsh::to_vec(&p.sealed).expect("borsh"));
        write_revealed(owner, &[]);
        emit("plan_sealed", near_sdk::serde_json::json!({"owner": owner, "heirs": p.sealed.commitments.len(), "unrevealed": p.sealed.unrevealed}));
    }

    pub(crate) fn private_is_current(&self, owner: &AccountId, p: &PrivatePlan) -> bool {
        sealed(owner).as_ref() == Some(&p.sealed) && self.read_plan(owner).is_some_and(|c| !changes::plan_high_impact(&c.policy, &p.plan))
    }

    /// The owner showed up: hide the heirs again.
    pub(crate) fn reseal(&mut self, owner: &AccountId) {
        if sealed(owner).is_none() {
            return;
        }
        let had = !revealed(owner).is_empty();
        write_revealed(owner, &[]);
        env::storage_remove(&btc_dests_key(owner));
        if let Some(plan) = self.plans.get_mut(owner) {
            if plan.proposal.is_none() && (had || !plan.policy.heirs.is_empty()) {
                plan.policy.heirs.clear();
                emit("plan_resealed", near_sdk::serde_json::json!({"owner": owner}));
            }
        }
    }

    /// Before a proposal on a sealed plan: rebuild the heirs from the
    /// revealed records (see the module docs). No-op for public plans and
    /// whenever `propose_release` will refuse anyway.
    pub(crate) fn unseal(&mut self, owner: &AccountId, t: u64) {
        let Some(s) = sealed(owner) else { return };
        let plan = self.plan_ref(owner);
        if plan.proposal.is_some() || t < overdue_at(&plan) {
            return;
        }
        let rv = revealed(owner);
        let all = rv.len() == s.commitments.len();
        if !all && t < overdue_at(&plan) + s.reveal_window_ms {
            fail(Error::RevealsPending);
        }
        let mut heirs: Vec<HeirInput> = rv
            .iter()
            .map(|r| HeirInput { account_id: r.account_id.clone(), share_bps: r.share_bps, near_destination: r.near_destination.clone(), eth_destination: r.eth_destination.clone() })
            .collect();
        let total: u32 = heirs.iter().map(|h| h.share_bps as u32).sum();
        if total < policy::TOTAL_BPS {
            match s.unrevealed {
                Unrevealed::Redistribute => normalize(&mut heirs),
                Unrevealed::Fallback => {
                    let f = read_rules(owner).and_then(|r| r.fallback).unwrap_or_else(|| fail(Error::InvalidSealedHeirs));
                    let rest = (policy::TOTAL_BPS - total) as u16;
                    match heirs.iter_mut().find(|h| h.account_id == f.account_id) {
                        Some(h) => h.share_bps += rest,
                        None => heirs.push(HeirInput { account_id: f.account_id, share_bps: rest, near_destination: f.near_destination, eth_destination: f.eth_destination }),
                    }
                }
            }
        }
        if heirs.is_empty() {
            fail(Error::NothingToDistribute);
        }
        let btc: Vec<BtcDestination> = rv.iter().filter_map(|r| r.btc_destination.clone().map(|a| BtcDestination { account_id: r.account_id.clone(), address: a })).collect();
        if btc.is_empty() {
            env::storage_remove(&btc_dests_key(owner));
        } else {
            env::storage_write(&btc_dests_key(owner), &near_sdk::borsh::to_vec(&btc).expect("borsh"));
        }
        let n = heirs.len();
        self.plan_mut(owner).policy.heirs = heirs;
        emit("plan_unsealed_for_release", near_sdk::serde_json::json!({"owner": owner, "revealed": rv.len(), "sealed": s.commitments.len(), "heirs": n}));
    }
}

#[near]
impl Contract {
    /// D33 (owner). Saves a sealed plan: `plan.heirs` must be empty and
    /// `sealed.commitments` holds one commitment per heir. Counts as a
    /// check-in. Under an edit notice, changes to the sealed heirs, guardians
    /// or quorum wait it out (timers apply at once), like `set_plan`.
    #[payable]
    pub fn set_private_plan(&mut self, plan: PlanInput, sealed: SealedHeirs) {
        let owner = caller();
        self.migrate_plan(&owner);
        if self.plans.contains_key(&owner) {
            self.archive_settled(&owner);
            self.reseal(&owner);
        }
        let before = env::storage_usage();
        let new_plan = !self.plans.contains_key(&owner);
        let p = self.check_private(&owner, PrivatePlan { plan, sealed });
        let notice = changes::notice(&owner);
        match self.read_plan(&owner) {
            Some(cur) if notice > 0 && !self.private_is_current(&owner, &p) => {
                let mut now_policy = cur.policy.clone();
                changes::copy_timers(&mut now_policy, &p.plan);
                self.queue_change(&owner, Change::Private(p), notice);
                self.write_plan(&owner, now_policy, true);
            }
            Some(_) if notice > 0 => {
                changes::drop_pending(&owner, changes::ChangeKind::Plan);
                self.write_plan(&owner, p.plan, true);
            }
            _ => self.write_private(&owner, p, true),
        }
        self.charge_storage(before, &owner, new_plan);
    }

    /// D33 (anyone). Reveals one sealed heir from its recovery record, once
    /// the owner is overdue and no release is open. Returns the heir's index.
    pub fn reveal_heir(&mut self, owner: AccountId, record: HeirRecord) -> u32 {
        let s = sealed(&owner).unwrap_or_else(|| fail(Error::NotSealed));
        let plan = self.plan_ref(&owner);
        let t = now();
        if plan.proposal.is_some() || t < overdue_at(&plan) {
            fail(Error::RevealNotOpen);
        }
        let mut record = record;
        if let Some(e) = &record.eth_destination {
            if !policy::is_eth_address(e) {
                fail(Error::InvalidEthAddress);
            }
        }
        if !is_hex64(&record.salt) {
            fail(Error::UnknownCommitment);
        }
        let c = commitment(&owner, &record);
        let index = s.commitments.iter().position(|x| *x == c).unwrap_or_else(|| fail(Error::UnknownCommitment)) as u32;
        let mut rv = revealed(&owner);
        if rv.iter().any(|r| r.index == index) {
            fail(Error::AlreadyRevealed);
        }
        record.eth_destination = record.eth_destination.map(|e| e.to_ascii_lowercase());
        if record.near_destination.is_none() && record.eth_destination.is_none() {
            fail(Error::NoDestination);
        }
        if record.btc_destination.as_deref().is_some_and(|a| btc::address_script(a).is_none()) {
            fail(Error::InvalidDestination);
        }
        if record.account_id == owner || plan.policy.guardians.contains(&record.account_id) || rv.iter().any(|r| r.account_id == record.account_id) {
            fail(Error::ConflictingRole);
        }
        let total: u32 = rv.iter().map(|r| r.share_bps as u32).sum::<u32>() + record.share_bps as u32;
        if total > policy::TOTAL_BPS {
            fail(Error::InvalidShares);
        }
        rv.push(RevealedHeir {
            index,
            account_id: record.account_id.clone(),
            share_bps: record.share_bps,
            near_destination: record.near_destination,
            eth_destination: record.eth_destination,
            btc_destination: record.btc_destination,
            revealed_at_ms: t,
        });
        rv.sort_by_key(|r| r.index);
        write_revealed(&owner, &rv);
        // Bounded (≤ 10 small records, cleared on re-seal): the contract absorbs the storage.
        emit("heir_revealed", near_sdk::serde_json::json!({"owner": owner, "index": index, "account_id": record.account_id, "revealed": rv.len(), "sealed": s.commitments.len()}));
        index
    }

    /// D33. The sealed configuration and what's been revealed (None: a public plan).
    pub fn get_private_heirs(&self, owner: AccountId) -> Option<PrivateView> {
        let s = sealed(&owner)?;
        let opens = self.read_plan(&owner).map(|p| overdue_at(&p)).unwrap_or(0);
        Some(PrivateView { reveal_deadline_ms: opens + s.reveal_window_ms, reveal_opens_at_ms: opens, revealed: revealed(&owner), commitments: s.commitments, reveal_window_ms: s.reveal_window_ms, unrevealed: s.unrevealed })
    }

    /// D33. The commitment of a record (for the app to check a record before saving or revealing).
    pub fn get_heir_commitment(&self, owner: AccountId, record: HeirRecord) -> String {
        commitment(&owner, &record)
    }
}
