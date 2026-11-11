//! D25. Plan tiers paid once, upfront, in one fee token (USDC on NEAR).
//!
//! A tier is a set of limits on what an owner can *save*: heir and guardian
//! counts, external assets (Ethereum and Bitcoin destinations, NEP-141
//! escrow), release rules, and advanced release options (automatic/hybrid
//! modes, per-heir overrides, delay signers). Tiers never touch check-ins,
//! proposals, votes, claims or transfers: an unpaid upgrade means "you can't
//! save this yet", never "your heirs can't inherit".
//!
//! Payments arrive by `ft_transfer_call` of the fee token with
//! `msg = {"pay_tier":"<owner>"}`, from anyone (the owner, a relative, NEAR
//! Intents on the owner's behalf). Every accepted payment is credit for that
//! owner: the owner holds the highest tier whose price the credit covers, and
//! keeps it if prices later rise. Paying more than a tier costs stays credit
//! toward the next one, so an upgrade only ever costs the difference and a
//! payment is never bounced back to an intermediary that can't receive it.
//! Fee revenue is kept in its own treasury record, apart from plan escrow,
//! chain-fee reserves and the sponsor pool.
//!
//! An owner may always keep what they already have: a save is allowed when
//! the new configuration needs no more than the larger of the paid tier and
//! the tier the current configuration needs. Plans saved before tiers
//! existed therefore stay editable at their level. With no fee token
//! configured, tiers are off and nothing is checked.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use crate::errors::{fail, Error};
use crate::policy::{MAX_GUARDIANS, MAX_HEIRS};
use crate::types::{PlanInput, ReleaseMode, ReleaseOptions, ReleaseRules};

const TIER_CFG_KEY: &[u8] = b"tier_cfg";
const TIER_PREFIX: &[u8] = b"tier:";
const TREASURY_KEY: &[u8] = b"treasury";
pub const MAX_TIERS: usize = 8;
const MAX_NAME: usize = 32;
const MAX_PAYMENT_MSG: usize = 256;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TierSpec {
    pub name: String,
    /// One-time price in the fee token's smallest unit.
    pub price: U128,
    pub max_heirs: u8,
    pub max_guardians: u8,
    /// Ethereum or Bitcoin destinations and NEP-141 escrow.
    pub external_assets: bool,
    /// Fixed amounts, alternates and the unclaimed-share fallback (D17).
    pub release_rules: bool,
    /// Automatic or hybrid release, per-heir/asset overrides, delay signers (D18/D19).
    pub advanced_release: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TierConfig {
    /// NEP-141 token tiers are paid in; `None` turns tiers off.
    pub fee_token: Option<AccountId>,
    pub fee_symbol: String,
    pub fee_decimals: u8,
    /// Cheapest first; `tiers[0]` is free and the last one allows everything.
    pub tiers: Vec<TierSpec>,
}

impl Default for TierConfig {
    fn default() -> Self {
        Self { fee_token: None, fee_symbol: "USDC".into(), fee_decimals: 6, tiers: default_tiers(6) }
    }
}

/// Free, Standard ($49) and Complete ($149), in a token with `decimals`.
pub fn default_tiers(decimals: u8) -> Vec<TierSpec> {
    let unit = 10u128.pow(decimals as u32);
    vec![
        TierSpec { name: "Free".into(), price: U128(0), max_heirs: 1, max_guardians: 3, external_assets: false, release_rules: false, advanced_release: false },
        TierSpec { name: "Standard".into(), price: U128(49 * unit), max_heirs: 5, max_guardians: 5, external_assets: true, release_rules: true, advanced_release: false },
        TierSpec {
            name: "Complete".into(),
            price: U128(149 * unit),
            max_heirs: MAX_HEIRS as u8,
            max_guardians: MAX_GUARDIANS as u8,
            external_assets: true,
            release_rules: true,
            advanced_release: true,
        },
    ]
}

/// What a plan's saved configuration uses, as far as tiers are concerned.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Features {
    pub heirs: u8,
    pub guardians: u8,
    pub external_assets: bool,
    pub release_rules: bool,
    pub advanced_release: bool,
}

pub fn features(policy: &PlanInput, rules: Option<&ReleaseRules>, options: Option<&ReleaseOptions>, btc_destinations: usize, token_escrow: bool) -> Features {
    Features {
        heirs: policy.heirs.len() as u8,
        guardians: policy.guardians.len() as u8,
        external_assets: token_escrow || btc_destinations > 0 || policy.heirs.iter().any(|h| h.eth_destination.is_some()),
        release_rules: rules.is_some(),
        advanced_release: options.is_some_and(|o| o.mode != ReleaseMode::Claim || !o.delay_signers.is_empty() || !o.overrides.is_empty()),
    }
}

impl TierSpec {
    pub fn allows(&self, f: &Features) -> bool {
        f.heirs <= self.max_heirs
            && f.guardians <= self.max_guardians
            && (self.external_assets || !f.external_assets)
            && (self.release_rules || !f.release_rules)
            && (self.advanced_release || !f.advanced_release)
    }
}

/// Per owner: total credit paid (never decreases) and the tier it bought.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
pub struct TierAccount {
    pub tier: u8,
    pub paid: u128,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct TierView {
    /// Tier the owner has paid for (0 = the free tier).
    pub tier: u8,
    pub tier_name: String,
    /// Total credit paid for this owner, in the fee token.
    pub paid: U128,
    /// Tier the plan's saved configuration needs (0 without a plan).
    pub required: u8,
    /// What the owner may save up to: max(tier, required).
    pub allowance: u8,
    /// Amount still due for each tier (0 for tiers already covered).
    pub due: Vec<U128>,
    pub enabled: bool,
    /// What the saved configuration uses (`None` without a plan).
    pub features: Option<Features>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct TreasuryView {
    pub fee_token: Option<AccountId>,
    pub collected: U128,
    pub withdrawn: U128,
    pub pending: U128,
    /// Fee-token balance the treasury holds now (collected − withdrawn − pending).
    pub balance: U128,
    pub payments: u64,
}

fn read<T: near_sdk::borsh::BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn write<T: near_sdk::borsh::BorshSerialize>(key: &[u8], v: &T) {
    env::storage_write(key, &near_sdk::borsh::to_vec(v).expect("borsh"));
}

pub fn config() -> TierConfig {
    read(TIER_CFG_KEY).unwrap_or_default()
}

pub fn enabled() -> bool {
    config().fee_token.is_some()
}

pub fn fee_token() -> Option<AccountId> {
    config().fee_token
}

/// Admin check of a new schedule: the first tier is free, prices strictly
/// rise, limits never shrink from one tier to the next, and the last tier
/// allows every plan the contract accepts (so no valid plan is unsaveable).
pub fn validate_config(c: &TierConfig) {
    let t = &c.tiers;
    let ok = !t.is_empty()
        && t.len() <= MAX_TIERS
        && c.fee_symbol.len() <= 16
        && c.fee_decimals <= 24
        && t[0].price.0 == 0
        && t.iter().all(|s| !s.name.is_empty() && s.name.len() <= MAX_NAME && s.max_heirs >= 1 && s.max_guardians >= 1)
        && t.windows(2).all(|w| {
            w[1].price.0 > w[0].price.0
                && w[1].max_heirs >= w[0].max_heirs
                && w[1].max_guardians >= w[0].max_guardians
                && (w[1].external_assets || !w[0].external_assets)
                && (w[1].release_rules || !w[0].release_rules)
                && (w[1].advanced_release || !w[0].advanced_release)
        })
        && t.last().is_some_and(|s| {
            s.max_heirs as usize >= MAX_HEIRS && s.max_guardians as usize >= MAX_GUARDIANS && s.external_assets && s.release_rules && s.advanced_release
        });
    if !ok {
        fail(Error::InvalidTiers);
    }
}

pub fn set_config(c: &TierConfig) {
    validate_config(c);
    write(TIER_CFG_KEY, c);
}

/// Cheapest tier allowing `f` (the last tier allows every valid plan).
pub fn required(c: &TierConfig, f: &Features) -> u8 {
    c.tiers.iter().position(|s| s.allows(f)).unwrap_or(c.tiers.len().saturating_sub(1)) as u8
}

fn account_key(owner: &AccountId) -> Vec<u8> {
    [TIER_PREFIX, owner.as_bytes()].concat()
}

pub fn account(owner: &AccountId) -> TierAccount {
    read(&account_key(owner)).unwrap_or_default()
}

/// Highest tier the credit covers at today's prices, or the tier already
/// bought if prices have risen since; capped at the schedule's last tier.
pub fn effective(c: &TierConfig, a: &TierAccount) -> u8 {
    let by_paid = c.tiers.iter().rposition(|s| s.price.0 <= a.paid).unwrap_or(0) as u8;
    let last = c.tiers.len().saturating_sub(1) as u8;
    by_paid.max(a.tier).min(last)
}

/// Refuses a save that needs more than the owner has paid for or already uses.
/// `before` is the plan's current configuration (`None` for a new plan).
pub fn check(owner: &AccountId, before: Option<&Features>, after: &Features) {
    let c = config();
    if c.fee_token.is_none() {
        return;
    }
    let allowance = effective(&c, &account(owner)).max(before.map(|f| required(&c, f)).unwrap_or(0));
    let need = required(&c, after);
    if need > allowance {
        env::panic_str(&format!("E_TIER_REQUIRED: this plan needs the {} tier", c.tiers[need as usize].name));
    }
}

/// True when the owner may hold NEP-141 tokens in escrow (an external asset).
pub fn allows_external(owner: &AccountId, current: Option<&Features>) -> bool {
    let c = config();
    if c.fee_token.is_none() {
        return true;
    }
    let allowance = effective(&c, &account(owner)).max(current.map(|f| required(&c, f)).unwrap_or(0));
    c.tiers[allowance as usize].external_assets
}

/// Parses `{"pay_tier":"<owner>"}`; anything else is not a tier payment.
pub fn payment_owner(msg: &str) -> Option<AccountId> {
    if msg.len() > MAX_PAYMENT_MSG {
        return None;
    }
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
    struct Pay {
        pay_tier: AccountId,
    }
    near_sdk::serde_json::from_str::<Pay>(msg.trim()).ok().map(|p| p.pay_tier)
}

/// A first payment for an owner must be at least one whole token, so tiny
/// transfers can't make the contract store records for arbitrary accounts.
pub fn acceptable(owner: &AccountId, amount: u128) -> bool {
    amount > 0 && (env::storage_has_key(&account_key(owner)) || amount >= 10u128.pow(config().fee_decimals as u32))
}

/// Admin: a new fee token only while the treasury has never collected.
pub fn token_change_allowed(c: &TierConfig) -> bool {
    let t = treasury();
    config().fee_token == c.fee_token || (t.collected == 0 && t.pending == 0)
}

/// Credits `amount` to `owner` and records it as treasury revenue.
/// Returns the owner's account after the payment.
pub fn credit(owner: &AccountId, amount: u128) -> TierAccount {
    let c = config();
    let mut a = account(owner);
    a.paid = a.paid.saturating_add(amount);
    a.tier = effective(&c, &a);
    write(&account_key(owner), &a);
    let mut t = treasury();
    t.collected = t.collected.saturating_add(amount);
    t.payments += 1;
    write(TREASURY_KEY, &t);
    a
}

/// Fee revenue, kept apart from escrow, chain-fee reserves and the sponsor pool.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
struct Treasury {
    collected: u128,
    withdrawn: u128,
    /// Sent to the admin's destination but not yet confirmed by the token.
    pending: u128,
    payments: u64,
}

fn treasury() -> Treasury {
    read(TREASURY_KEY).unwrap_or_default()
}

/// Reserves `amount` for an admin withdrawal in flight.
pub fn begin_withdrawal(amount: u128) {
    let mut t = treasury();
    if amount == 0 || amount > t.collected - t.withdrawn - t.pending {
        fail(Error::InsufficientTreasury);
    }
    t.pending += amount;
    write(TREASURY_KEY, &t);
}

/// Settles a withdrawal: spent on success, returned to the balance otherwise.
pub fn end_withdrawal(amount: u128, ok: bool) {
    let mut t = treasury();
    t.pending -= amount;
    if ok {
        t.withdrawn += amount;
    }
    write(TREASURY_KEY, &t);
}

pub fn treasury_view() -> TreasuryView {
    let t = treasury();
    TreasuryView {
        fee_token: fee_token(),
        collected: U128(t.collected),
        withdrawn: U128(t.withdrawn),
        pending: U128(t.pending),
        balance: U128(t.collected - t.withdrawn - t.pending),
        payments: t.payments,
    }
}

pub fn view(owner: &AccountId, current: Option<&Features>) -> TierView {
    let c = config();
    let a = account(owner);
    let tier = effective(&c, &a);
    let required = current.map(|f| required(&c, f)).unwrap_or(0);
    TierView {
        tier,
        tier_name: c.tiers.get(tier as usize).map(|s| s.name.clone()).unwrap_or_default(),
        paid: U128(a.paid),
        required,
        allowance: tier.max(required),
        due: c.tiers.iter().enumerate().map(|(i, s)| U128(if i as u8 <= tier { 0 } else { s.price.0.saturating_sub(a.paid) })).collect(),
        enabled: c.fee_token.is_some(),
        features: current.copied(),
    }
}
