//! D29: guardian recovery without ever lowering the quorum.
//!
//! - **Standby guardians**: an ordered list the owner names in advance. When
//!   a guardian has resigned, or (with availability checks on) hasn't
//!   confirmed within the availability window, anyone may ask for the next
//!   available standby to take that seat. A resigned seat is filled at once;
//!   an unresponsive one after `swap_delay_ms`, during which the owner can
//!   cancel and the guardian cancels simply by confirming.
//! - **Availability checks**: guardians (and standbys) confirm with
//!   `confirm_guardian`; proposing or voting counts too. `get_guardian_status`
//!   says who is available and whether the quorum can still be reached, so a
//!   plan short of quorum is visibly paused rather than silently weakened.
//! - **Key rotation**: a guardian moves its seat to a new account after
//!   `swap_delay_ms`; the owner (or the guardian's old key) can cancel.
//! - **Resignation**: a guardian leaves. With no standby left the seat stays
//!   listed as resigned and the plan waits for the owner or a standby.
//!
//! The quorum never changes here, and the seat count stays the same. Settings
//! live beside the plan (no migration); runtime state (last seen, resigned,
//! pending changes) in its own record.
use near_sdk::{env, near, AccountId};

use crate::changes::Change;
use crate::errors::{fail, Error};
use crate::types::{PlanInput, ReleaseRules};
use crate::*;

pub const MAX_STANDBYS: usize = 5;

const MINUTE: u64 = 60_000;
const DAY: u64 = 24 * 60 * MINUTE;

#[cfg(feature = "demo-timers")]
pub const AVAILABILITY: (u64, u64) = (MINUTE, 365 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const AVAILABILITY: (u64, u64) = (30 * DAY, 365 * DAY);
#[cfg(feature = "demo-timers")]
pub const SWAP_DELAY: (u64, u64) = (MINUTE, 90 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const SWAP_DELAY: (u64, u64) = (DAY, 90 * DAY);

/// Owner-chosen. `availability_ms` 0 turns availability checks off (only a
/// resignation can then bring in a standby).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardianSettings {
    pub standbys: Vec<AccountId>,
    pub availability_ms: u64,
    /// Notice before a standby takes an unresponsive guardian's seat or a
    /// rotation lands; the owner can cancel during it.
    pub swap_delay_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GuardianChangeKind {
    Standby,
    Rotation,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardianChange {
    pub kind: GuardianChangeKind,
    pub out: AccountId,
    pub into: AccountId,
    pub requested_by: AccountId,
    pub requested_at_ms: u64,
    pub effective_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct GuardianState {
    /// Last confirmation (or vote) per guardian and standby.
    pub seen: Vec<(AccountId, u64)>,
    pub resigned: Vec<AccountId>,
    pub pending: Vec<GuardianChange>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardianSeat {
    pub account_id: AccountId,
    pub last_seen_ms: Option<u64>,
    pub available: bool,
    pub resigned: bool,
    /// A standby can be asked for now (resigned, or unconfirmed past the window).
    pub replaceable: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardianStatus {
    pub tracking: bool,
    pub availability_ms: u64,
    pub swap_delay_ms: u64,
    pub quorum: u8,
    pub available: u8,
    /// False: fewer guardians are available than the quorum. Releases wait
    /// for a standby, the owner, or a guardian to come back.
    pub quorum_reachable: bool,
    pub guardians: Vec<GuardianSeat>,
    pub standbys: Vec<GuardianSeat>,
    pub pending: Vec<GuardianChange>,
}

fn settings_key(owner: &AccountId) -> Vec<u8> {
    [b"gset:".as_slice(), owner.as_bytes()].concat()
}

fn state_key(owner: &AccountId) -> Vec<u8> {
    [b"gst:".as_slice(), owner.as_bytes()].concat()
}

pub fn read_settings(owner: &AccountId) -> Option<GuardianSettings> {
    env::storage_read(&settings_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

pub fn read_state(owner: &AccountId) -> Option<GuardianState> {
    env::storage_read(&state_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn write_state(owner: &AccountId, st: &GuardianState) {
    env::storage_write(&state_key(owner), &near_sdk::borsh::to_vec(st).expect("borsh"));
}

pub fn standby_count(owner: &AccountId) -> usize {
    read_settings(owner).map(|s| s.standbys.len()).unwrap_or(0)
}

pub fn is_resigned(owner: &AccountId, g: &AccountId) -> bool {
    read_state(owner).is_some_and(|s| s.resigned.contains(g))
}

fn in_bounds(v: u64, (lo, hi): (u64, u64)) -> bool {
    v >= lo && v <= hi
}

fn seen_of(st: &GuardianState, a: &AccountId) -> Option<u64> {
    st.seen.iter().find(|(x, _)| x == a).map(|(_, t)| *t)
}

fn set_seen(st: &mut GuardianState, a: &AccountId, t: u64) {
    match st.seen.iter_mut().find(|(x, _)| x == a) {
        Some(e) => e.1 = t,
        None => st.seen.push((a.clone(), t)),
    }
}

fn available(st: &GuardianState, s: Option<&GuardianSettings>, a: &AccountId, t: u64) -> bool {
    if st.resigned.contains(a) {
        return false;
    }
    match s.map(|s| s.availability_ms).filter(|w| *w > 0) {
        // No record yet counts as available: tracking starts when it is turned on.
        Some(w) => seen_of(st, a).is_none_or(|at| t < at.saturating_add(w)),
        None => true,
    }
}

/// Validates settings against a plan (and its release rules): standbys are
/// outsiders who could become guardians, so the guardian rules apply to them.
pub fn validate_settings(owner: &AccountId, p: &PlanInput, rules: Option<&ReleaseRules>, s: GuardianSettings) -> GuardianSettings {
    let unique: std::collections::HashSet<&AccountId> = s.standbys.iter().collect();
    let recipient = |a: &AccountId| rules.is_some_and(|r| r.alternates.iter().any(|x| &x.recipient.account_id == a) || r.fallback.as_ref().is_some_and(|f| &f.account_id == a));
    if s.standbys.len() > MAX_STANDBYS
        || unique.len() != s.standbys.len()
        || s.standbys.iter().any(|a| a == owner || p.guardians.contains(a) || p.heirs.iter().any(|h| &h.account_id == a) || recipient(a))
    {
        fail(Error::InvalidGuardianSettings);
    }
    if (s.availability_ms != 0 && !in_bounds(s.availability_ms, AVAILABILITY)) || !in_bounds(s.swap_delay_ms, SWAP_DELAY) {
        fail(Error::DurationOutOfBounds);
    }
    s
}

/// Called whenever the guardian list changes: records start for new seats,
/// drops records and pending changes of accounts that no longer hold one.
pub fn sync(owner: &AccountId, guardians: &[AccountId]) {
    let settings = read_settings(owner);
    let st = read_state(owner);
    if st.is_none() && settings.is_none() {
        return;
    }
    let mut st = st.unwrap_or_default();
    let standbys = settings.as_ref().map(|s| s.standbys.clone()).unwrap_or_default();
    let t = env::block_timestamp_ms();
    st.seen.retain(|(a, _)| guardians.contains(a) || standbys.contains(a));
    for a in guardians.iter().chain(standbys.iter()) {
        if seen_of(&st, a).is_none() {
            st.seen.push((a.clone(), t));
        }
    }
    st.resigned.retain(|a| guardians.contains(a));
    st.pending.retain(|c| guardians.contains(&c.out) && (c.kind == GuardianChangeKind::Rotation || standbys.contains(&c.into)));
    write_state(owner, &st);
}

/// A guardian acted (proposed, voted): counts as a confirmation and calls off
/// a standby taking its seat.
pub fn touch(owner: &AccountId, g: &AccountId) {
    if let Some(mut st) = read_state(owner) {
        set_seen(&mut st, g, env::block_timestamp_ms());
        cancel_standby_for(owner, &mut st, g);
        write_state(owner, &st);
    }
}

fn cancel_standby_for(owner: &AccountId, st: &mut GuardianState, g: &AccountId) {
    if let Some(i) = st.pending.iter().position(|c| &c.out == g && c.kind == GuardianChangeKind::Standby) {
        let c = st.pending.remove(i);
        emit("guardian_change_cancelled", near_sdk::serde_json::json!({"owner": owner, "out": c.out, "into": c.into, "kind": c.kind, "by": g, "reason": "guardian_confirmed"}));
    }
}

impl Contract {
    pub(crate) fn check_guardian_settings(&self, owner: &AccountId, settings: Option<GuardianSettings>) -> Option<GuardianSettings> {
        let plan = self.plan_ref(owner);
        let rules = read_rules(owner);
        let s = settings.map(|s| validate_settings(owner, &plan.policy, rules.as_ref(), s));
        let mut after = tier_features(owner, &plan.policy);
        after.guardians = (plan.policy.guardians.len() + s.as_ref().map(|s| s.standbys.len()).unwrap_or(0)) as u8;
        tiers::check(owner, Some(&tier_features(owner, &plan.policy)), &after);
        s
    }

    pub(crate) fn write_guardian_settings(&mut self, owner: &AccountId, settings: Option<GuardianSettings>) {
        match &settings {
            Some(s) => env::storage_write(&settings_key(owner), &near_sdk::borsh::to_vec(s).expect("borsh")),
            None => env::storage_remove(&settings_key(owner)),
        };
        sync(owner, &self.plan_ref(owner).policy.guardians);
        emit("guardian_settings_set", near_sdk::serde_json::json!({"owner": owner, "settings": settings}));
    }

    fn swap_delay(&self, owner: &AccountId) -> u64 {
        read_settings(owner).map(|s| s.swap_delay_ms).unwrap_or_else(|| self.plan_ref(owner).policy.waiting_period_ms)
    }

    /// Moves seat `out` to `into`. The guardian count and quorum are unchanged;
    /// the plan is re-validated, so `into` can't be the owner, a heir, a
    /// guardian, an alternate or the fallback. Votes `out` cast on a proposal
    /// still collecting approvals are withdrawn.
    fn swap_seat(&mut self, owner: &AccountId, out: &AccountId, into: &AccountId, kind: GuardianChangeKind) {
        let mut policy = self.plan_ref(owner).policy;
        let i = policy.guardians.iter().position(|g| g == out).unwrap_or_else(|| fail(Error::NotGuardian));
        policy.guardians[i] = into.clone();
        let policy = policy::validate(owner, policy);
        if let Some(r) = read_rules(owner) {
            policy::validate_rules(owner, &policy, r, |a| btc_dest(owner, a).is_some());
        }
        let plan = self.plan_mut(owner);
        plan.policy = policy;
        if let Some(p) = plan.proposal.as_mut().filter(|p| p.approved_at_ms.is_none()) {
            p.approvals.retain(|a| a != out);
            p.rejections.retain(|a| a != out);
        }
        if kind == GuardianChangeKind::Standby {
            if let Some(mut s) = read_settings(owner) {
                s.standbys.retain(|a| a != into);
                env::storage_write(&settings_key(owner), &near_sdk::borsh::to_vec(&s).expect("borsh"));
            }
        }
        let mut st = read_state(owner).unwrap_or_default();
        st.seen.retain(|(a, _)| a != out);
        set_seen(&mut st, into, env::block_timestamp_ms());
        st.resigned.retain(|a| a != out);
        st.pending.retain(|c| &c.out != out && &c.into != into);
        write_state(owner, &st);
        emit("guardian_replaced", near_sdk::serde_json::json!({"owner": owner, "out": out, "into": into, "kind": kind}));
    }

    /// The first standby that is free (not already headed for a seat) and,
    /// with availability checks on, has confirmed within the window.
    fn next_standby(&self, _owner: &AccountId, st: &GuardianState, s: &GuardianSettings, t: u64) -> Option<AccountId> {
        s.standbys.iter().find(|a| !st.pending.iter().any(|c| &c.into == *a) && available(st, Some(s), a, t)).cloned()
    }

    fn available_count(&self, owner: &AccountId, st: &GuardianState, t: u64) -> usize {
        let s = read_settings(owner);
        self.plan_ref(owner).policy.guardians.iter().filter(|g| available(st, s.as_ref(), g, t)).count()
    }
}

#[near]
impl Contract {
    /// D29 (owner). Standby guardians, the availability window and the swap
    /// notice; `None` clears them. Standbys count toward the tier's guardian
    /// limit. Waits out the owner's edit notice (D28), if one is set.
    #[payable]
    pub fn set_guardian_settings(&mut self, settings: Option<GuardianSettings>) {
        self.owner_edit(Change::Guardians(settings));
    }

    pub fn get_guardian_settings(&self, owner: AccountId) -> Option<GuardianSettings> {
        read_settings(&owner)
    }

    pub fn get_guardian_status(&self, owner: AccountId) -> GuardianStatus {
        let plan = self.plan_ref(&owner);
        let s = read_settings(&owner);
        let st = read_state(&owner).unwrap_or_default();
        let t = env::block_timestamp_ms();
        let free_standby = s.as_ref().and_then(|s| self.next_standby(&owner, &st, s, t)).is_some();
        let seat = |a: &AccountId, guardian: bool| {
            let avail = available(&st, s.as_ref(), a, t);
            GuardianSeat {
                account_id: a.clone(),
                last_seen_ms: seen_of(&st, a),
                available: avail,
                resigned: st.resigned.contains(a),
                replaceable: guardian && !avail && free_standby && !st.pending.iter().any(|c| &c.out == a),
            }
        };
        let guardians: Vec<GuardianSeat> = plan.policy.guardians.iter().map(|g| seat(g, true)).collect();
        let n = guardians.iter().filter(|g| g.available).count() as u8;
        GuardianStatus {
            tracking: s.as_ref().is_some_and(|s| s.availability_ms > 0),
            availability_ms: s.as_ref().map(|s| s.availability_ms).unwrap_or(0),
            swap_delay_ms: s.as_ref().map(|s| s.swap_delay_ms).unwrap_or(plan.policy.waiting_period_ms),
            quorum: plan.policy.quorum,
            available: n,
            quorum_reachable: n >= plan.policy.quorum,
            guardians,
            standbys: s.as_ref().map(|s| s.standbys.iter().map(|a| seat(a, false)).collect()).unwrap_or_default(),
            pending: st.pending.clone(),
        }
    }

    /// D29. A guardian or standby says "I'm still here". Calls off a standby
    /// taking this guardian's seat.
    pub fn confirm_guardian(&mut self, owner: AccountId) {
        let me = caller();
        let plan = self.plan_ref(&owner);
        let standby = read_settings(&owner).is_some_and(|s| s.standbys.contains(&me));
        if !plan.policy.guardians.contains(&me) && !standby {
            fail(Error::NotGuardian);
        }
        let mut st = read_state(&owner).unwrap_or_default();
        if st.resigned.contains(&me) {
            fail(Error::GuardianResigned);
        }
        set_seen(&mut st, &me, env::block_timestamp_ms());
        cancel_standby_for(&owner, &mut st, &me);
        write_state(&owner, &st);
        emit("guardian_confirmed", near_sdk::serde_json::json!({"owner": owner, "account_id": me}));
    }

    /// D29 (anyone). Ask the next standby to take `guardian`'s seat: at once
    /// if it resigned, after the swap notice if it is past the availability
    /// window. Returns the standby.
    pub fn request_standby(&mut self, owner: AccountId, guardian: AccountId) -> AccountId {
        let me = caller();
        let plan = self.plan_ref(&owner);
        if !plan.policy.guardians.contains(&guardian) {
            fail(Error::NotGuardian);
        }
        let s = read_settings(&owner).unwrap_or_else(|| fail(Error::NoStandby));
        let mut st = read_state(&owner).unwrap_or_default();
        if st.pending.iter().any(|c| c.out == guardian) {
            fail(Error::GuardianChangePending);
        }
        let t = env::block_timestamp_ms();
        let resigned = st.resigned.contains(&guardian);
        if !resigned && (s.availability_ms == 0 || available(&st, Some(&s), &guardian, t)) {
            fail(Error::GuardianAvailable);
        }
        let into = self.next_standby(&owner, &st, &s, t).unwrap_or_else(|| fail(Error::NoStandby));
        if resigned {
            self.swap_seat(&owner, &guardian, &into, GuardianChangeKind::Standby);
            return into;
        }
        let c = GuardianChange { kind: GuardianChangeKind::Standby, out: guardian, into: into.clone(), requested_by: me, requested_at_ms: t, effective_at_ms: t + s.swap_delay_ms };
        emit("guardian_change_requested", near_sdk::serde_json::json!({"owner": owner, "change": c}));
        st.pending.push(c);
        write_state(&owner, &st);
        into
    }

    /// D29. A guardian moves its seat to `new_account` (a new key or wallet)
    /// after the swap notice. The owner or this guardian can cancel meanwhile.
    pub fn rotate_guardian(&mut self, owner: AccountId, new_account: AccountId) {
        let me = caller();
        let plan = self.plan_ref(&owner);
        if !plan.policy.guardians.contains(&me) {
            fail(Error::NotGuardian);
        }
        let mut st = read_state(&owner).unwrap_or_default();
        if st.resigned.contains(&me) {
            fail(Error::GuardianResigned);
        }
        if st.pending.iter().any(|c| c.out == me || c.into == new_account) {
            fail(Error::GuardianChangePending);
        }
        // The same checks a seat swap runs, up front.
        let mut policy = plan.policy.clone();
        let i = policy.guardians.iter().position(|g| *g == me).expect("guardian");
        policy.guardians[i] = new_account.clone();
        let policy = policy::validate(&owner, policy);
        if let Some(r) = read_rules(&owner) {
            policy::validate_rules(&owner, &policy, r, |a| btc_dest(&owner, a).is_some());
        }
        if read_settings(&owner).is_some_and(|s| s.standbys.contains(&new_account)) {
            fail(Error::ConflictingRole);
        }
        let t = env::block_timestamp_ms();
        let c = GuardianChange { kind: GuardianChangeKind::Rotation, out: me.clone(), into: new_account, requested_by: me.clone(), requested_at_ms: t, effective_at_ms: t + self.swap_delay(&owner) };
        emit("guardian_change_requested", near_sdk::serde_json::json!({"owner": owner, "change": c}));
        set_seen(&mut st, &me, t);
        st.pending.push(c);
        write_state(&owner, &st);
    }

    /// D29. A guardian steps down. The next available standby takes the seat
    /// at once; with none, the seat stays listed as resigned (it can't vote)
    /// and the quorum is unchanged.
    pub fn resign_guardian(&mut self, owner: AccountId) {
        let me = caller();
        let plan = self.plan_ref(&owner);
        if !plan.policy.guardians.contains(&me) {
            fail(Error::NotGuardian);
        }
        let mut st = read_state(&owner).unwrap_or_default();
        if st.resigned.contains(&me) {
            fail(Error::GuardianResigned);
        }
        st.pending.retain(|c| c.out != me);
        st.resigned.push(me.clone());
        write_state(&owner, &st);
        emit("guardian_resigned", near_sdk::serde_json::json!({"owner": owner, "account_id": me}));
        let t = env::block_timestamp_ms();
        if let Some(into) = read_settings(&owner).and_then(|s| self.next_standby(&owner, &st, &s, t)) {
            self.swap_seat(&owner, &me, &into, GuardianChangeKind::Standby);
            return;
        }
        let n = self.available_count(&owner, &st, t);
        if n < plan.policy.quorum as usize {
            emit("guardian_quorum_lost", near_sdk::serde_json::json!({"owner": owner, "available": n, "quorum": plan.policy.quorum}));
        }
    }

    /// D29 (anyone). Completes a requested standby swap or rotation once its
    /// notice has passed.
    pub fn finalize_guardian_change(&mut self, owner: AccountId, guardian: AccountId) {
        let st = read_state(&owner).unwrap_or_default();
        let c = st.pending.iter().find(|c| c.out == guardian).cloned().unwrap_or_else(|| fail(Error::NoGuardianChange));
        let t = env::block_timestamp_ms();
        if t < c.effective_at_ms {
            fail(Error::ChangeNotDue);
        }
        if c.kind == GuardianChangeKind::Standby && !read_settings(&owner).is_some_and(|s| s.standbys.contains(&c.into)) {
            fail(Error::NoStandby);
        }
        self.swap_seat(&owner, &c.out, &c.into, c.kind);
    }

    /// D29. The owner calls off any pending seat change; a guardian calls off
    /// its own rotation (confirming calls off a standby swap).
    pub fn cancel_guardian_change(&mut self, owner: AccountId, guardian: AccountId) {
        let me = caller();
        if me != owner && me != guardian {
            fail(Error::Unauthorized);
        }
        let mut st = read_state(&owner).unwrap_or_default();
        let i = st.pending.iter().position(|c| c.out == guardian).unwrap_or_else(|| fail(Error::NoGuardianChange));
        let c = st.pending.remove(i);
        write_state(&owner, &st);
        emit("guardian_change_cancelled", near_sdk::serde_json::json!({"owner": owner, "out": c.out, "into": c.into, "kind": c.kind, "by": me, "reason": "cancelled"}));
    }
}

