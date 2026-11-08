use near_sdk::json_types::U128;
use near_sdk::AccountId;
use std::collections::HashSet;

use crate::errors::{fail, Error};
use crate::types::{Asset, FixedAmount, ModeOverride, PlanInput, Recipient, ReleaseMode, ReleaseOptions, ReleaseRules};

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
        // 0 is allowed: such a heir receives only a fixed amount or the
        // remainder (release rules, D17).
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

pub const MAX_FIXED: usize = 20;

#[cfg(feature = "demo-timers")]
pub const CLAIM_WINDOW: (u64, u64) = (MINUTE, 3 * 365 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const CLAIM_WINDOW: (u64, u64) = (30 * DAY, 3 * 365 * DAY);

fn check_recipient(r: &mut Recipient) {
    if r.near_destination.is_none() && r.eth_destination.is_none() {
        fail(Error::InvalidRules);
    }
    if let Some(a) = &r.eth_destination {
        if !is_eth_address(a) {
            fail(Error::InvalidEthAddress);
        }
        r.eth_destination = Some(a.to_ascii_lowercase());
    }
}

/// Validates release rules against the current plan. Alternates and the
/// fallback must be outsiders (not the owner, a heir or a guardian) so a
/// transfer's current holder always says which step of the chain it is at.
pub fn validate_rules(owner: &AccountId, p: &PlanInput, mut r: ReleaseRules, has_btc: impl Fn(&AccountId) -> bool) -> ReleaseRules {
    let heir = |a: &AccountId| p.heirs.iter().find(|h| &h.account_id == a);
    let insider = |a: &AccountId| a == owner || heir(a).is_some() || p.guardians.contains(a);
    if r.fixed.len() > MAX_FIXED || r.alternates.len() > MAX_HEIRS {
        fail(Error::InvalidRules);
    }
    for f in r.fixed.iter_mut() {
        if let Asset::Erc20(t) = &f.asset {
            f.asset = Asset::Erc20(t.to_ascii_lowercase());
        }
    }
    for f in &r.fixed {
        let h = heir(&f.heir).unwrap_or_else(|| fail(Error::InvalidRules));
        let has_dest = if f.asset.is_evm() {
            h.eth_destination.is_some()
        } else if f.asset.is_btc() {
            has_btc(&h.account_id)
        } else {
            h.near_destination.is_some()
        };
        if f.amount.0 == 0 || !has_dest || r.fixed.iter().filter(|g| g.heir == f.heir && g.asset == f.asset).count() > 1 {
            fail(Error::InvalidRules);
        }
    }
    if r.remainder_to.as_ref().is_some_and(|a| heir(a).is_none()) {
        fail(Error::InvalidRules);
    }
    let mut seen = HashSet::new();
    for a in r.alternates.iter_mut() {
        if heir(&a.heir).is_none() || !seen.insert(a.heir.clone()) || insider(&a.recipient.account_id) {
            fail(Error::InvalidRules);
        }
        check_recipient(&mut a.recipient);
    }
    if let Some(f) = r.fallback.as_mut() {
        if insider(&f.account_id) || r.alternates.iter().any(|a| a.recipient.account_id == f.account_id) {
            fail(Error::InvalidRules);
        }
        check_recipient(f);
    }
    let reassigns = !r.alternates.is_empty() || r.fallback.is_some();
    if reassigns && !in_bounds(r.claim_window_ms, CLAIM_WINDOW) {
        fail(Error::DurationOutOfBounds);
    }
    r
}

#[cfg(feature = "demo-timers")]
pub const HYBRID_GRACE: (u64, u64) = (MINUTE, 180 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const HYBRID_GRACE: (u64, u64) = (DAY, 180 * DAY);
#[cfg(feature = "demo-timers")]
pub const EXTENSION: (u64, u64) = (MINUTE, 90 * DAY);
#[cfg(not(feature = "demo-timers"))]
pub const EXTENSION: (u64, u64) = (DAY, 90 * DAY);
pub const MAX_TOTAL_EXTENSION: u64 = 365 * DAY;
pub const MAX_DELAY_SIGNERS: usize = 10;

/// Validates release options against the plan. Delay signers may overlap with
/// guardians (disclosed in the UI) but are never the owner or a heir, who have
/// their own interests in the timing.
fn check_mode(mode: ReleaseMode, grace: u64) {
    if mode == ReleaseMode::Hybrid {
        if !in_bounds(grace, HYBRID_GRACE) {
            fail(Error::DurationOutOfBounds);
        }
    } else if grace != 0 {
        fail(Error::InvalidOptions);
    }
}

pub const MAX_OVERRIDES: usize = 20;

pub fn validate_options(owner: &AccountId, p: &PlanInput, o: ReleaseOptions) -> ReleaseOptions {
    check_mode(o.mode, o.hybrid_grace_ms);
    if o.overrides.len() > MAX_OVERRIDES {
        fail(Error::InvalidOptions);
    }
    for x in &o.overrides {
        check_mode(x.mode, x.hybrid_grace_ms);
        if x.heir.as_ref().is_some_and(|h| !p.heirs.iter().any(|y| &y.account_id == h)) {
            fail(Error::InvalidOptions);
        }
    }
    let s = &o.delay_signers;
    let unique: HashSet<_> = s.iter().collect();
    if s.len() > MAX_DELAY_SIGNERS || unique.len() != s.len() || s.iter().any(|a| a == owner || p.heirs.iter().any(|h| &h.account_id == a)) {
        fail(Error::InvalidOptions);
    }
    if s.is_empty() {
        if o.delay_quorum != 0 || o.max_extension_ms != 0 || o.max_total_extension_ms != 0 {
            fail(Error::InvalidOptions);
        }
    } else {
        if o.delay_quorum == 0 || o.delay_quorum as usize > s.len() {
            fail(Error::InvalidQuorum);
        }
        if !in_bounds(o.max_extension_ms, EXTENSION) || o.max_total_extension_ms < o.max_extension_ms || o.max_total_extension_ms > MAX_TOTAL_EXTENSION {
            fail(Error::DurationOutOfBounds);
        }
    }
    o
}

/// The mode and grace that apply to a transfer held by `heir` (the first
/// matching override, else the plan's). A share reassigned to an alternate or
/// the fallback has no heir-specific override and follows the asset-group or
/// plan mode.
pub fn mode_for(o: &ReleaseOptions, heir: &AccountId, asset: &Asset) -> (ReleaseMode, u64) {
    o.overrides
        .iter()
        .find(|x| x.heir.as_ref().is_none_or(|h| h == heir) && x.assets.contains(asset))
        .map(|x: &ModeOverride| (x.mode, x.hybrid_grace_ms))
        .unwrap_or((o.mode, o.hybrid_grace_ms))
}

/// Splits `total` of one asset: fixed amounts first (in rule order, capped by
/// what is left), then `share_bps` of the rest, then the rounding remainder to
/// `remainder_to`. Only heirs with a destination for the asset's chain
/// (`eligible`) receive; the shares of the others stay undistributed.
/// Returns one amount per heir, in plan order.
pub fn split(total: u128, p: &PlanInput, rules: &ReleaseRules, asset: &Asset, eligible: impl Fn(usize) -> bool) -> Vec<u128> {
    split_detailed(total, p, rules, asset, eligible).0
}

/// `split`, plus the part of each heir's amount that came from fixed
/// amounts (D21: fixed amounts are paid once across release rounds).
pub fn split_detailed(total: u128, p: &PlanInput, rules: &ReleaseRules, asset: &Asset, eligible: impl Fn(usize) -> bool) -> (Vec<u128>, Vec<u128>) {
    let mut out = vec![0u128; p.heirs.len()];
    let mut fixed = vec![0u128; p.heirs.len()];
    let mut left = total;
    for f in rules.fixed.iter().filter(|f| &f.asset == asset) {
        if let Some(i) = p.heirs.iter().position(|h| h.account_id == f.heir).filter(|i| eligible(*i)) {
            let paid = f.amount.0.min(left);
            out[i] += paid;
            fixed[i] += paid;
            left -= paid;
        }
    }
    let mut shared = 0u128;
    for (i, h) in p.heirs.iter().enumerate() {
        let s = share_of(left, h.share_bps);
        shared += s;
        if eligible(i) {
            out[i] += s;
        }
    }
    if let Some(i) = rules.remainder_to.as_ref().and_then(|a| p.heirs.iter().position(|h| &h.account_id == a)).filter(|i| eligible(*i)) {
        out[i] += left - shared;
    }
    (out, fixed)
}

/// The rules with each fixed amount reduced by what earlier rounds already
/// paid that heir in that asset (saturating; a fully paid one drops out).
pub fn rules_after_paid(rules: &ReleaseRules, paid: &[FixedAmount]) -> ReleaseRules {
    let mut r = rules.clone();
    let mut done: Vec<FixedAmount> = paid.to_vec();
    for f in r.fixed.iter_mut() {
        if let Some(d) = done.iter_mut().find(|d| d.heir == f.heir && d.asset == f.asset) {
            let used = d.amount.0.min(f.amount.0);
            f.amount = U128(f.amount.0 - used);
            d.amount = U128(d.amount.0 - used);
        }
    }
    r.fixed.retain(|f| f.amount.0 > 0);
    r
}

/// `floor(total * bps / 10_000)`; the remainder stays undistributed (D12).
pub fn share_of(total: u128, bps: u16) -> u128 {
    total / TOTAL_BPS as u128 * bps as u128 + (total % TOTAL_BPS as u128) * bps as u128 / TOTAL_BPS as u128
}
