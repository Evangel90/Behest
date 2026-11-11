//! D27: heirs can receive through NEAR Intents. A recipient (heir, named
//! alternate or the fallback) who opts in is paid into their account inside
//! the Intents verifier (`intents.near` on mainnet) instead of their wallet:
//!
//! - NEAR: one receipt to the wNEAR contract with two actions, `near_deposit`
//!   then `ft_transfer_call` to the verifier with msg `{"receiver_id": <their
//!   Intents account>}`. Batched actions are atomic, so if wrapping fails the
//!   transfer never runs and can't touch other plans' wNEAR escrow.
//! - NEP-141 tokens: `ft_transfer_call` from escrow straight to the verifier.
//!
//! `ft_transfer_call` returns what the receiver kept. Anything handed back is
//! a failure: the transfer goes `Failed`, the refunded part returns to escrow
//! (wNEAR is unwrapped back to NEAR) and the normal retry path sends only
//! what is still unpaid. What did arrive is recorded per transfer, so a retry
//! never pays it twice. Settings live beside the plan (no migration) and are
//! frozen while a release is open.
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

/// Admin: where Intents lives on this network. Moving to mainnet is a config change.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IntentsConfig {
    /// The Intents verifier contract (`intents.near`; a mock on testnet).
    pub verifier: AccountId,
    /// The wNEAR token NEAR is wrapped into before it is sent (`wrap.near`).
    pub wnear: AccountId,
}

/// Owner: one recipient's choice. `intents_account` is their account inside
/// Intents (a NEAR account, or a `0x…` address for an Ethereum wallet);
/// defaults to their NEAR destination.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IntentsDelivery {
    pub account_id: AccountId,
    pub enabled: bool,
    pub intents_account: Option<AccountId>,
}

/// What a transfer has delivered into Intents so far, and wNEAR still held for it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct IntentsProgress {
    pub paid: U128,
    /// wNEAR wrapped for this transfer and handed back, not yet unwrapped.
    pub wrapped: U128,
}

const CONFIG_KEY: &[u8] = b"intents_cfg";

pub fn config() -> Option<IntentsConfig> {
    env::storage_read(CONFIG_KEY).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

pub fn set_config(c: Option<&IntentsConfig>) {
    match c {
        Some(c) => {
            env::storage_write(CONFIG_KEY, &near_sdk::borsh::to_vec(c).expect("borsh"));
        }
        None => {
            env::storage_remove(CONFIG_KEY);
        }
    }
}

pub fn delivery_key(owner: &AccountId) -> Vec<u8> {
    [b"idl:".as_slice(), owner.as_bytes()].concat()
}

pub fn deliveries(owner: &AccountId) -> Vec<IntentsDelivery> {
    env::storage_read(&delivery_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

/// The Intents account `recipient` is paid into, when they opted in.
pub fn target(owner: &AccountId, recipient: &AccountId, near_destination: &str) -> Option<AccountId> {
    let d = deliveries(owner).into_iter().find(|d| &d.account_id == recipient && d.enabled)?;
    d.intents_account.or_else(|| near_destination.parse().ok()).or(Some(d.account_id))
}

fn progress_key(owner: &AccountId, proposal_id: u64, index: u32) -> Vec<u8> {
    format!("itx:{owner}:{proposal_id}:{index}").into_bytes()
}

pub fn progress(owner: &AccountId, proposal_id: u64, index: u32) -> IntentsProgress {
    env::storage_read(&progress_key(owner, proposal_id, index)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

pub fn set_progress(owner: &AccountId, proposal_id: u64, index: u32, p: &IntentsProgress) {
    let k = progress_key(owner, proposal_id, index);
    if p.paid.0 == 0 && p.wrapped.0 == 0 {
        env::storage_remove(&k);
    } else {
        env::storage_write(&k, &near_sdk::borsh::to_vec(p).expect("borsh"));
    }
}

/// Behest registered `account` with `token` (itself for wNEAR, the verifier for every token it sends).
fn registered_key(token: &AccountId, account: &AccountId) -> Vec<u8> {
    format!("ireg:{token}:{account}").into_bytes()
}
pub fn is_registered(token: &AccountId, account: &AccountId) -> bool {
    env::storage_has_key(&registered_key(token, account))
}
pub fn mark_registered(token: &AccountId, account: &AccountId) {
    env::storage_write(&registered_key(token, account), &[1]);
}

/// The verifier's deposit message: credit `receiver` inside Intents.
pub fn deposit_msg(receiver: &AccountId) -> String {
    near_sdk::serde_json::json!({ "receiver_id": receiver }).to_string()
}

/// `ft_transfer_call`'s result is the amount the receiver kept (a JSON U128).
pub fn used_amount(result: &[u8]) -> Option<u128> {
    near_sdk::serde_json::from_slice::<U128>(result).ok().map(|u| u.0)
}
