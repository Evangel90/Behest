use near_sdk::AccountId;
use std::collections::HashSet;

use crate::errors::{fail, Error};
use crate::types::PlanInput;

pub const MAX_HEIRS: usize = 10;
pub const MAX_GUARDIANS: usize = 10;
pub const TOTAL_BPS: u32 = 10_000;

const MINUTE: u64 = 60_000;
const DAY: u64 = 24 * 60 * MINUTE;

/// Inclusive (min, max) bounds in ms. Compiled in so a production build can
/// never accept demo timers (threat model #16).
pub struct TimerBounds {
    pub check_in: (u64, u64),
    pub grace: (u64, u64),
    pub waiting: (u64, u64),
}

#[cfg(feature = "demo-timers")]
pub const TIMERS: TimerBounds = TimerBounds {
    check_in: (MINUTE, 365 * DAY),
    grace: (0, 30 * DAY),
    waiting: (MINUTE, 180 * DAY),
};

#[cfg(not(feature = "demo-timers"))]
pub const TIMERS: TimerBounds = TimerBounds {
    check_in: (30 * DAY, 365 * DAY),
    grace: (DAY, 30 * DAY),
    waiting: (7 * DAY, 180 * DAY),
};

fn in_bounds(v: u64, (lo, hi): (u64, u64)) -> bool {
    v >= lo && v <= hi
}

pub fn is_eth_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validates and normalizes a plan. Panics with a coded error on failure.
pub fn validate(owner: &AccountId, mut p: PlanInput) -> PlanInput {
    if p.heirs.is_empty() || p.heirs.len() > MAX_HEIRS {
        fail(Error::InvalidHeirs);
    }
    let mut heir_ids = HashSet::new();
    let mut total: u32 = 0;
    for h in p.heirs.iter_mut() {
        if !heir_ids.insert(h.account_id.clone()) {
            fail(Error::DuplicateHeir);
        }
        if h.share_bps == 0 {
            fail(Error::InvalidShares);
        }
        total += h.share_bps as u32;
        if h.near_destination.is_none() && h.eth_destination.is_none() {
            fail(Error::NoDestination);
        }
        if let Some(a) = &h.eth_destination {
            if !is_eth_address(a) {
                fail(Error::InvalidEthAddress);
            }
            h.eth_destination = Some(a.to_ascii_lowercase());
        }
    }
    if total != TOTAL_BPS {
        fail(Error::InvalidShares);
    }

    let guardians: HashSet<_> = p.guardians.iter().collect();
    if p.guardians.is_empty() || p.guardians.len() > MAX_GUARDIANS || guardians.len() != p.guardians.len() {
        fail(Error::InvalidGuardians);
    }
    if p.quorum == 0 || p.quorum as usize > p.guardians.len() {
        fail(Error::InvalidQuorum);
    }
    if guardians.contains(owner) || p.guardians.iter().any(|g| heir_ids.contains(g)) {
        fail(Error::ConflictingRole);
    }

    if !in_bounds(p.check_in_interval_ms, TIMERS.check_in)
        || !in_bounds(p.grace_ms, TIMERS.grace)
        || !in_bounds(p.waiting_period_ms, TIMERS.waiting)
    {
        fail(Error::DurationOutOfBounds);
    }
    p
}

/// `floor(total * bps / 10_000)`; the remainder stays undistributed (D12).
pub fn share_of(total: u128, bps: u16) -> u128 {
    total / TOTAL_BPS as u128 * bps as u128 + (total % TOTAL_BPS as u128) * bps as u128 / TOTAL_BPS as u128
}
