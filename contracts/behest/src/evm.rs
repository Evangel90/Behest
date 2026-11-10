//! D23: EVM wallets act through contract-verified signatures, and D24: a
//! sponsor pool pays plan storage for sponsored owners.
//!
//! An EVM wallet signs a readable `personal_sign` (EIP-191) message:
//!
//! ```text
//! Behest signed action
//! <summary for the human; not checked>
//!
//! {"contract":"behest.testnet","network":"testnet","actor":"0x…","method":"claim","args":{…},"nonce":"0","deadline_ms":"…"}
//! ```
//!
//! `evm_call` recovers the signer, checks the JSON is bound to this contract,
//! network, signer, the signer's next nonce and an unexpired deadline, then
//! runs one allowlisted method with `caller()` returning the signer's
//! eth-implicit account id (`0x` + 40 lowercase hex). The override lives only
//! for that synchronous dispatch: a guard clears it on return and on unwind,
//! and every callback is a separate receipt (a fresh wasm instance), so it can
//! never apply there. Privileged checks (admin, executor) ignore it.
//!
//! State lives under raw storage keys (no migration): `evmn:<actor>` nonces,
//! `sponsor_cfg`, `sponsor_pool`, `sponsor_day`, `spo:<owner>`.

use std::cell::RefCell;

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::Value;
use near_sdk::{env, near, AccountId};

use crate::errors::{fail, Error};

pub const MAX_MESSAGE_BYTES: usize = 8 * 1024;
pub const HEADER: &str = "Behest signed action\n";
/// Default lifetime storage allowance per sponsored owner (0.1 NEAR).
pub const DEFAULT_ALLOWANCE: u128 = 100_000_000_000_000_000_000_000;
pub const DEFAULT_DAILY_NEW_PLANS: u32 = 50;
const DAY_MS: u64 = 86_400_000;

const NONCE_PREFIX: &[u8] = b"evmn:";
const SPONSOR_CFG_KEY: &[u8] = b"sponsor_cfg";
const SPONSOR_POOL_KEY: &[u8] = b"sponsor_pool";
const SPONSOR_DAY_KEY: &[u8] = b"sponsor_day";
const SPONSORED_PREFIX: &[u8] = b"spo:";

/// secp256k1 group order n, and n / 2 (big-endian).
const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const SECP256K1_HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

// ------------------------------------------------------------- acting-as

thread_local! {
    static ACTING_AS: RefCell<Option<AccountId>> = const { RefCell::new(None) };
}

/// The account `caller()` reports while an `evm_call` dispatch runs.
pub fn acting_as() -> Option<AccountId> {
    ACTING_AS.with(|a| a.borrow().clone())
}

/// Sets the acting-as account for its lifetime; dropping it (return or
/// unwind) clears it. Refuses to nest.
pub struct ActingAs(());

impl ActingAs {
    pub fn enter(actor: AccountId) -> Self {
        ACTING_AS.with(|a| {
            let mut a = a.borrow_mut();
            if a.is_some() {
                fail(Error::EvmMethod);
            }
            *a = Some(actor);
        });
        ActingAs(())
    }
}

impl Drop for ActingAs {
    fn drop(&mut self) {
        ACTING_AS.with(|a| *a.borrow_mut() = None);
    }
}

// ------------------------------------------------------- signed actions

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ActionJson {
    contract: String,
    network: String,
    actor: String,
    method: String,
    args: Value,
    nonce: String,
    deadline_ms: String,
}

/// A signed action that passed every check except the method allowlist.
pub struct Verified {
    pub actor: AccountId,
    pub method: String,
    pub args: Value,
    pub nonce: u64,
}

/// "testnet" or "mainnet", from the contract's own account id.
pub fn network() -> &'static str {
    if env::current_account_id().as_str().ends_with(".near") {
        "mainnet"
    } else {
        "testnet"
    }
}

/// A canonical unsigned decimal (no sign, no leading zeros, no spaces).
fn parse_decimal(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    s.parse().ok()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The EIP-191 `personal_sign` hash of `message`.
pub fn eip191_hash(message: &str) -> [u8; 32] {
    let mut data = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    data.extend_from_slice(message.as_bytes());
    env::keccak256_array(&data)
}

/// Recovers the signer's address (`0x` + 40 lowercase hex) from a 65-byte
/// `r ‖ s ‖ v` signature. Rejects any other length, `v` outside 27/28/0/1,
/// zero or out-of-range `r`/`s`, and high-S (malleable) signatures.
pub fn recover(message: &str, signature: &str) -> String {
    let hex = signature.strip_prefix("0x").unwrap_or_else(|| fail(Error::EvmSignature));
    let sig = hex_decode(hex).filter(|b| b.len() == 65).unwrap_or_else(|| fail(Error::EvmSignature));
    let (r, s) = (&sig[..32], &sig[32..64]);
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => fail(Error::EvmSignature),
    };
    let zero = [0u8; 32];
    if r == zero || s == zero || r >= &SECP256K1_N[..] || s > &SECP256K1_HALF_N[..] {
        fail(Error::EvmSignature);
    }
    let pk = env::ecrecover(&eip191_hash(message), &sig[..64], v, true).unwrap_or_else(|| fail(Error::EvmSignature));
    let h = env::keccak256_array(&pk);
    format!("0x{}", crate::eth::hex_encode(&h[12..]))
}

/// Parses and checks a signed action: header, JSON, contract, network,
/// actor = signer, nonce = the actor's next nonce, deadline not passed.
pub fn verify(message: &str, signature: &str) -> Verified {
    if message.len() > MAX_MESSAGE_BYTES {
        fail(Error::EvmMessage);
    }
    let rest = message.strip_prefix(HEADER).unwrap_or_else(|| fail(Error::EvmMessage));
    let (summary, body) = rest.split_once("\n\n").unwrap_or_else(|| fail(Error::EvmMessage));
    if summary.contains('\n') || summary.contains('\r') {
        fail(Error::EvmMessage);
    }
    let a: ActionJson = near_sdk::serde_json::from_str(body).unwrap_or_else(|_| fail(Error::EvmMessage));
    if !a.args.is_object() {
        fail(Error::EvmArgs);
    }
    if a.contract != env::current_account_id().as_str() || a.network != network() {
        fail(Error::EvmWrongContract);
    }
    let signer = recover(message, signature);
    if a.actor.to_ascii_lowercase() != signer {
        fail(Error::EvmActor);
    }
    let actor: AccountId = signer.parse().unwrap_or_else(|_| fail(Error::EvmActor));
    let deadline = parse_decimal(&a.deadline_ms).unwrap_or_else(|| fail(Error::EvmMessage));
    if env::block_timestamp_ms() > deadline {
        fail(Error::EvmExpired);
    }
    let nonce = parse_decimal(&a.nonce).unwrap_or_else(|| fail(Error::EvmMessage));
    if nonce != get_nonce(&actor) {
        fail(Error::EvmNonce);
    }
    Verified { actor, method: a.method, args: a.args, nonce }
}

fn nonce_key(actor: &AccountId) -> Vec<u8> {
    [NONCE_PREFIX, actor.as_bytes()].concat()
}

pub fn get_nonce(actor: &AccountId) -> u64 {
    env::storage_read(&nonce_key(actor)).and_then(|b| b.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0)
}

pub fn set_nonce(actor: &AccountId, nonce: u64) {
    env::storage_write(&nonce_key(actor), &nonce.to_le_bytes());
}

/// Deserializes a method's arguments strictly: unknown fields are refused,
/// so what was signed is exactly what runs.
macro_rules! evm_args {
    ($v:expr, { $($name:ident : $ty:ty),* $(,)? }) => {{
        #[derive(near_sdk::serde::Deserialize)]
        #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
        #[allow(dead_code)]
        struct A { $($name: $ty),* }
        let a: A = near_sdk::serde_json::from_value($v).unwrap_or_else(|_| $crate::errors::fail($crate::errors::Error::EvmArgs));
        let _ = &a;
        ($(a.$name),*)
    }};
}
pub(crate) use evm_args;

// ------------------------------------------------------------- sponsorship

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SponsorConfig {
    /// The relayer whose transactions (`signer_account_id`) are sponsored.
    pub relayer: Option<AccountId>,
    /// Lifetime storage cost the pool pays per owner (yocto).
    pub allowance_per_owner: U128,
    /// New plans the pool pays for per UTC day, across all owners.
    pub daily_new_plans: u32,
}

impl Default for SponsorConfig {
    fn default() -> Self {
        Self { relayer: None, allowance_per_owner: U128(DEFAULT_ALLOWANCE), daily_new_plans: DEFAULT_DAILY_NEW_PLANS }
    }
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct SponsorshipView {
    pub pool: U128,
    pub allowance_left: U128,
    pub daily_left: u32,
}

/// Per owner: lifetime cost the pool paid (never decreases) and the bytes it
/// currently backs (freed storage returns to the pool up to this).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
pub struct Sponsored {
    pub spent: u128,
    pub bytes: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
struct DayCount {
    day: u64,
    count: u32,
}

fn read<T: near_sdk::borsh::BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn write<T: near_sdk::borsh::BorshSerialize>(key: &[u8], v: &T) {
    env::storage_write(key, &near_sdk::borsh::to_vec(v).expect("borsh"));
}

fn sponsored_key(owner: &AccountId) -> Vec<u8> {
    [SPONSORED_PREFIX, owner.as_bytes()].concat()
}

pub fn config() -> SponsorConfig {
    read(SPONSOR_CFG_KEY).unwrap_or_default()
}

pub fn set_config(c: &SponsorConfig) {
    write(SPONSOR_CFG_KEY, c);
}

pub fn pool() -> u128 {
    read(SPONSOR_POOL_KEY).unwrap_or(0)
}

pub fn set_pool(v: u128) {
    write(SPONSOR_POOL_KEY, &v);
}

pub fn sponsored(owner: &AccountId) -> Option<Sponsored> {
    read(&sponsored_key(owner))
}

fn today() -> u64 {
    env::block_timestamp_ms() / DAY_MS
}

fn day_count() -> DayCount {
    read::<DayCount>(SPONSOR_DAY_KEY).filter(|d| d.day == today()).unwrap_or(DayCount { day: today(), count: 0 })
}

pub fn view(owner: &AccountId) -> SponsorshipView {
    let c = config();
    let spent = sponsored(owner).map(|s| s.spent).unwrap_or(0);
    SponsorshipView {
        pool: U128(pool()),
        allowance_left: U128(c.allowance_per_owner.0.saturating_sub(spent)),
        daily_left: c.daily_new_plans.saturating_sub(day_count().count),
    }
}

/// True if this transaction comes from the registered sponsor relayer.
pub fn sponsor_signer() -> bool {
    config().relayer.is_some_and(|r| r == env::signer_account_id())
}

/// Writes the bookkeeping records a sponsored charge updates, before the
/// caller measures storage: they are fixed-size, so their own bytes are
/// part of the cost and later updates don't change usage.
pub fn prepare(owner: &AccountId, new_plan: bool) {
    let key = sponsored_key(owner);
    if env::storage_read(&key).is_none() {
        write(&key, &Sponsored::default());
    }
    if new_plan {
        write(SPONSOR_DAY_KEY, &day_count());
    }
    if env::storage_read(SPONSOR_POOL_KEY).is_none() {
        set_pool(0);
    }
}

/// Pays `bytes` of storage costing `cost` from the pool, within the owner's
/// allowance and (for a new plan) the daily cap; otherwise E_SPONSOR_EXHAUSTED.
pub fn spend(owner: &AccountId, cost: u128, bytes: u64, new_plan: bool) {
    let c = config();
    let mut s = sponsored(owner).unwrap_or_default();
    let p = pool();
    let mut day = day_count();
    if s.spent.saturating_add(cost) > c.allowance_per_owner.0 || p < cost || (new_plan && day.count >= c.daily_new_plans) {
        fail(Error::SponsorExhausted);
    }
    s.spent += cost;
    s.bytes += bytes;
    write(&sponsored_key(owner), &s);
    set_pool(p - cost);
    if new_plan {
        day.count += 1;
        write(SPONSOR_DAY_KEY, &day);
    }
}

/// Freed storage goes back to the pool for the part the pool paid for. The
/// owner gets nothing from it, so pool money can't be withdrawn this way.
pub fn credit(owner: &AccountId, freed: u64, byte_cost: u128) {
    let Some(mut s) = sponsored(owner) else { return };
    let back = freed.min(s.bytes);
    if back == 0 {
        return;
    }
    s.bytes -= back;
    write(&sponsored_key(owner), &s);
    set_pool(pool() + back as u128 * byte_cost);
}
