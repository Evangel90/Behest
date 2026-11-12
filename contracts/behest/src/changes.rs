//! D28: an edit notice (cooling-off period) for high-impact owner edits.
//!
//! With a notice set (`set_edit_notice`), a change to heirs, destinations,
//! allocations, guardians, quorum, release mode or standby guardians is
//! validated and queued instead of applied. It takes effect once the notice
//! has passed and anyone calls `apply_changes`; until then the owner can
//! cancel it, and guardians and heirs are told it is coming. A compromised
//! owner key therefore can't quietly re-route an inheritance: the real owner
//! has the notice period to secure the account and cancel.
//!
//! - Timer changes (check-in interval, grace, waiting period) and check-in
//!   delegates apply at once; a plan edit that also changes timers applies
//!   them now and queues the rest.
//! - Raising the notice applies at once; lowering or removing it waits out
//!   the current notice.
//! - One pending change per kind; a new one replaces it and restarts its
//!   notice. Restating the current value calls a pending one off.
//! - Applying re-validates against the plan as it is then, and like a direct
//!   edit is refused while a release is open (the change waits).
//! - Withdrawals stay immediate: those are the owner's own assets.
use near_sdk::{env, near, AccountId};

use crate::errors::{fail, Error};
use crate::guardians::GuardianSettings;
use crate::intents::IntentsDelivery;
use crate::types::{BtcDestination, PlanInput, ReleaseOptions, ReleaseRules};
use crate::*;

const MINUTE: u64 = 60_000;
const DAY: u64 = 24 * 60 * MINUTE;

#[cfg(feature = "demo-timers")]
pub const NOTICE: (u64, u64) = (MINUTE, 90 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const NOTICE: (u64, u64) = (DAY, 90 * DAY);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Plan(PlanInput),
    Guardians(Option<GuardianSettings>),
    Rules(Option<ReleaseRules>),
    Options(Option<ReleaseOptions>),
    Btc(Vec<BtcDestination>),
    Intents(Vec<IntentsDelivery>),
    Notice(u64),
}

/// Also the order `apply_changes` applies due changes in: the plan first,
/// since the rest are validated against it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangeKind {
    Plan,
    Guardians,
    Rules,
    Options,
    Btc,
    Intents,
    Notice,
}

impl Change {
    pub fn kind(&self) -> ChangeKind {
        match self {
            Change::Plan(_) => ChangeKind::Plan,
            Change::Guardians(_) => ChangeKind::Guardians,
            Change::Rules(_) => ChangeKind::Rules,
            Change::Options(_) => ChangeKind::Options,
            Change::Btc(_) => ChangeKind::Btc,
            Change::Intents(_) => ChangeKind::Intents,
            Change::Notice(_) => ChangeKind::Notice,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub change: Change,
    pub queued_at_ms: u64,
    pub effective_at_ms: u64,
}

fn notice_key(owner: &AccountId) -> Vec<u8> {
    [b"ntc:".as_slice(), owner.as_bytes()].concat()
}

fn pending_key(owner: &AccountId) -> Vec<u8> {
    [b"chg:".as_slice(), owner.as_bytes()].concat()
}

pub fn notice(owner: &AccountId) -> u64 {
    env::storage_read(&notice_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or(0)
}

fn write_notice(owner: &AccountId, n: u64) {
    if n == 0 {
        env::storage_remove(&notice_key(owner));
    } else {
        env::storage_write(&notice_key(owner), &near_sdk::borsh::to_vec(&n).expect("borsh"));
    }
}

pub fn pending(owner: &AccountId) -> Vec<PendingChange> {
    env::storage_read(&pending_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn write_pending(owner: &AccountId, v: &[PendingChange]) {
    if v.is_empty() {
        env::storage_remove(&pending_key(owner));
    } else {
        env::storage_write(&pending_key(owner), &near_sdk::borsh::to_vec(v).expect("borsh"));
    }
}

/// Removes the pending change of `kind`, if any (emits `change_cancelled`).
pub fn drop_pending(owner: &AccountId, kind: ChangeKind) -> bool {
    let mut v = pending(owner);
    let n = v.len();
    v.retain(|c| c.change.kind() != kind);
    if v.len() == n {
        return false;
    }
    write_pending(owner, &v);
    emit("change_cancelled", near_sdk::serde_json::json!({"owner": owner, "kind": kind}));
    true
}

/// Heirs (accounts, shares, destinations), guardians or quorum differ.
pub fn plan_high_impact(a: &PlanInput, b: &PlanInput) -> bool {
    a.heirs != b.heirs || a.guardians != b.guardians || a.quorum != b.quorum
}

pub fn copy_timers(dst: &mut PlanInput, src: &PlanInput) {
    dst.check_in_interval_ms = src.check_in_interval_ms;
    dst.grace_ms = src.grace_ms;
    dst.waiting_period_ms = src.waiting_period_ms;
}

impl Contract {
    /// An owner edit other than `set_plan`: validated now, then applied at
    /// once (no notice) or queued.
    pub(crate) fn owner_edit(&mut self, change: Change) {
        let owner = caller();
        let before = env::storage_usage();
        self.apply_or_queue(&owner, change);
        self.charge_storage(before, &owner, false);
    }

    /// Validates `change` for `owner`, then writes it, or queues it when the
    /// owner has an edit notice. Returns true when queued.
    pub(crate) fn apply_or_queue(&mut self, owner: &AccountId, change: Change) -> bool {
        let change = self.check_change(owner, change);
        let n = notice(owner);
        if n == 0 {
            self.write_change(owner, change);
            false
        } else if self.is_current(owner, &change) {
            drop_pending(owner, change.kind());
            false
        } else {
            self.queue_change(owner, change, n);
            true
        }
    }

    pub(crate) fn queue_change(&mut self, owner: &AccountId, change: Change, notice_ms: u64) {
        let t = env::block_timestamp_ms();
        let mut v = pending(owner);
        v.retain(|c| c.change.kind() != change.kind());
        let p = PendingChange { change, queued_at_ms: t, effective_at_ms: t + notice_ms };
        emit("change_queued", near_sdk::serde_json::json!({"owner": owner, "kind": p.change.kind(), "effective_at_ms": p.effective_at_ms, "change": p.change}));
        v.push(p);
        v.sort_by_key(|c| c.change.kind());
        write_pending(owner, &v);
    }

    /// Validates (and normalizes) a change against the plan as it is now.
    pub(crate) fn check_change(&self, owner: &AccountId, change: Change) -> Change {
        match change {
            Change::Plan(p) => Change::Plan(self.check_plan(owner, p)),
            Change::Guardians(g) => Change::Guardians(self.check_guardian_settings(owner, g)),
            Change::Rules(r) => Change::Rules(self.check_rules(owner, r)),
            Change::Options(o) => Change::Options(self.check_options(owner, o)),
            Change::Btc(d) => Change::Btc(self.check_btc_destinations(owner, d)),
            Change::Intents(d) => Change::Intents(self.check_intents_delivery(owner, d)),
            Change::Notice(n) => {
                self.plan_ref(owner);
                if n != 0 && !(n >= NOTICE.0 && n <= NOTICE.1) {
                    fail(Error::DurationOutOfBounds);
                }
                Change::Notice(n)
            }
        }
    }

    pub(crate) fn write_change(&mut self, owner: &AccountId, change: Change) {
        match change {
            Change::Plan(p) => self.write_plan(owner, p, false),
            Change::Guardians(g) => self.write_guardian_settings(owner, g),
            Change::Rules(r) => self.write_rules(owner, r),
            Change::Options(o) => self.write_options(owner, o),
            Change::Btc(d) => self.write_btc_destinations(owner, d),
            Change::Intents(d) => self.write_intents_delivery(owner, d),
            Change::Notice(n) => {
                write_notice(owner, n);
                emit("edit_notice_set", near_sdk::serde_json::json!({"owner": owner, "notice_ms": n}));
            }
        }
    }

    fn is_current(&self, owner: &AccountId, change: &Change) -> bool {
        match change {
            Change::Plan(p) => self.read_plan(owner).is_some_and(|c| !plan_high_impact(&c.policy, p)),
            Change::Guardians(g) => &crate::guardians::read_settings(owner) == g,
            Change::Rules(r) => &read_rules(owner) == r,
            Change::Options(o) => &read_options(owner) == o,
            Change::Btc(d) => &btc_dests(owner) == d,
            Change::Intents(d) => &intents::deliveries(owner) == d,
            Change::Notice(n) => notice(owner) == *n,
        }
    }
}

#[near]
impl Contract {
    /// D28 (owner). How long high-impact edits wait before they take effect;
    /// 0 turns the notice off. Raising it applies at once; lowering it waits
    /// out the current notice.
    #[payable]
    pub fn set_edit_notice(&mut self, notice_ms: u64) {
        let owner = caller();
        let before = env::storage_usage();
        let change = self.check_change(&owner, Change::Notice(notice_ms));
        let cur = notice(&owner);
        if notice_ms >= cur {
            drop_pending(&owner, ChangeKind::Notice);
            self.write_change(&owner, change);
        } else {
            self.queue_change(&owner, change, cur);
        }
        self.charge_storage(before, &owner, false);
    }

    pub fn get_edit_notice(&self, owner: AccountId) -> u64 {
        notice(&owner)
    }

    pub fn get_pending_changes(&self, owner: AccountId) -> Vec<PendingChange> {
        pending(&owner)
    }

    /// D28 (owner). Calls off a pending change (`None`: all of them).
    pub fn cancel_change(&mut self, kind: Option<ChangeKind>) {
        let owner = caller();
        let before = env::storage_usage();
        let kinds: Vec<ChangeKind> = pending(&owner).iter().map(|c| c.change.kind()).filter(|k| kind.is_none_or(|x| x == *k)).collect();
        if kinds.is_empty() {
            fail(Error::NoPendingChange);
        }
        for k in kinds {
            drop_pending(&owner, k);
        }
        self.charge_storage(before, &owner, false);
    }

    /// D28 (anyone). Applies the owner's pending changes whose notice has
    /// passed (or just `kind`), re-validated against the plan as it is now.
    /// Returns what was applied.
    pub fn apply_changes(&mut self, owner: AccountId, kind: Option<ChangeKind>) -> Vec<ChangeKind> {
        let t = env::block_timestamp_ms();
        self.archive_settled(&owner);
        let all = pending(&owner);
        let matching: Vec<&PendingChange> = all.iter().filter(|c| kind.is_none_or(|k| k == c.change.kind())).collect();
        if matching.is_empty() {
            fail(Error::NoPendingChange);
        }
        let due: Vec<PendingChange> = matching.into_iter().filter(|c| c.effective_at_ms <= t).cloned().collect();
        if due.is_empty() {
            fail(Error::ChangeNotDue);
        }
        let mut applied = vec![];
        for c in due {
            let k = c.change.kind();
            let change = match c.change {
                // Timers were applied when it was queued (and may have moved since).
                Change::Plan(mut p) => {
                    changes_copy_current_timers(self, &owner, &mut p);
                    Change::Plan(p)
                }
                other => other,
            };
            let change = self.check_change(&owner, change);
            let mut v = pending(&owner);
            v.retain(|x| x.change.kind() != k);
            write_pending(&owner, &v);
            self.write_change(&owner, change);
            emit("change_applied", near_sdk::serde_json::json!({"owner": owner, "kind": k}));
            applied.push(k);
        }
        applied
    }
}

fn changes_copy_current_timers(c: &Contract, owner: &AccountId, p: &mut PlanInput) {
    let cur = c.plan_ref(owner).policy;
    copy_timers(p, &cur);
}
