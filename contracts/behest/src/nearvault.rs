//! A plan's NEAR vault: a NEAR implicit account whose only key is derived for
//! this contract by the MPC network (Ed25519, domain 1), like the Ethereum
//! and Bitcoin vaults. Anyone can send NEAR to it from any wallet, exchange
//! or faucet, so an owner who signs in with an Ethereum wallet (and can't
//! attach NEAR to a call) can still fund the plan.
//!
//! The vault key only ever signs one transaction shape, built here: a single
//! `deposit({owner})` call on this contract from the vault account, with the
//! swept amount attached. So vault funds can only end up in the plan's
//! escrow. The executor supplies the access-key nonce, a recent block hash
//! and the amount (it reads the vault's balance); a wrong value only makes
//! the transaction invalid. If the deposit fails (a release is open), the
//! NEAR goes back to the vault.
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

use crate::errors::{fail, Error};
use crate::*;

pub const MPC_DOMAIN_ED25519: u32 = 1;
/// Gas the vault's `deposit` call gets (the vault pays for it from its balance).
pub const SWEEP_DEPOSIT_GAS: u64 = 10_000_000_000_000;
const KEY_PREFIX: &[u8] = b"nvpk:";
const SWEEP_PREFIX: &[u8] = b"nvs:";
const COUNT_KEY: &[u8] = b"nvn";
const INDEX_PREFIX: &[u8] = b"nvi:";

pub fn near_vault_path(owner: &AccountId) -> String {
    format!("behest/v1/{owner}/near")
}

fn key(prefix: &[u8], owner: &AccountId) -> Vec<u8> {
    [prefix, owner.as_bytes()].concat()
}

pub fn vault_key(owner: &AccountId) -> Option<[u8; 32]> {
    env::storage_read(&key(KEY_PREFIX, owner)).and_then(|v| v.try_into().ok())
}

pub fn base58_encode(b: &[u8]) -> String {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![];
    for &byte in b {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = b.iter().take_while(|x| **x == 0).count();
    let mut s = "1".repeat(zeros);
    s.extend(digits.iter().rev().map(|d| A[*d as usize] as char));
    s
}

fn borsh_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend((s.len() as u32).to_le_bytes());
    out.extend(s);
}

/// Borsh `Transaction` (V0) with one `FunctionCall` action, as near-api-js encodes it.
#[allow(clippy::too_many_arguments)]
pub fn function_call_tx(signer: &str, public_key: &[u8; 32], nonce: u64, receiver: &str, block_hash: &[u8; 32], method: &str, args: &[u8], gas: u64, deposit: u128) -> Vec<u8> {
    let mut t = vec![];
    borsh_str(&mut t, signer.as_bytes());
    t.push(0); // KeyType::ED25519
    t.extend(public_key);
    t.extend(nonce.to_le_bytes());
    borsh_str(&mut t, receiver.as_bytes());
    t.extend(block_hash);
    t.extend(1u32.to_le_bytes()); // one action
    t.push(2); // Action::FunctionCall
    borsh_str(&mut t, method.as_bytes());
    borsh_str(&mut t, args);
    t.extend(gas.to_le_bytes());
    t.extend(deposit.to_le_bytes());
    t
}

/// The sweep transaction's bytes for `owner`'s vault.
pub fn sweep_tx(contract: &AccountId, owner: &AccountId, pk: &[u8; 32], nonce: u64, block_hash: &[u8; 32], amount: u128) -> Vec<u8> {
    let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "owner": owner })).expect("json");
    function_call_tx(&eth::hex_encode(pk), pk, nonce, contract.as_str(), block_hash, "deposit", &args, SWEEP_DEPOSIT_GAS, amount)
}

/// Reads an Ed25519 signature from the MPC response, in the shapes it may take.
pub fn parse_ed25519(v: &near_sdk::serde_json::Value) -> Option<[u8; 64]> {
    use near_sdk::serde_json::Value;
    let sig = match v {
        Value::Object(m) => m.get("signature").or_else(|| m.get("Ed25519").and_then(|x| x.get("signature")))?,
        other => other,
    };
    let bytes: Vec<u8> = match sig {
        Value::Array(a) => a.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok())).collect::<Option<_>>()?,
        Value::String(s) => eth::hex_decode(s.trim_start_matches("0x")).or_else(|| base58_decode(s.trim_start_matches("ed25519:")))?,
        Value::Object(m) => return parse_ed25519(m.get("bytes").or_else(|| m.get("signature"))?),
        _ => return None,
    };
    bytes.try_into().ok()
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct NearVaultSweep {
    pub nonce: u64,
    pub amount: U128,
    /// sha256 of the transaction, hex: what the vault key signs.
    pub hash: String,
    /// Borsh `SignedTransaction`, base64, once signed.
    pub signed_tx: Option<String>,
    pub requested_at_ms: u64,
}

#[near(serializers = [json])]
pub struct NearVaultView {
    pub path: String,
    pub public_key: String,
    pub account_id: String,
}

fn read_sweep(owner: &AccountId) -> Option<NearVaultSweep> {
    env::storage_read(&key(SWEEP_PREFIX, owner)).and_then(|v| near_sdk::borsh::from_slice(&v).ok())
}

#[near]
impl Contract {
    /// Looks up the plan's NEAR vault key from the MPC contract (once) and
    /// stores it. Anyone may call it; the key is whatever MPC derives for this
    /// contract and path.
    pub fn register_near_vault(&mut self, owner: AccountId) -> Promise {
        self.plan_ref(&owner);
        if vault_key(&owner).is_some() {
            fail(Error::NearVaultExists);
        }
        mpc::ext(self.mpc_contract.clone())
            .with_static_gas(Gas::from_tgas(10))
            .derived_public_key(near_vault_path(&owner), Some(env::current_account_id()), Some(MPC_DOMAIN_ED25519))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_near_vault_key(owner))
    }

    #[private]
    pub fn on_near_vault_key(&mut self, owner: AccountId) -> bool {
        let key_str = env::promise_result_checked(0, 512).ok().and_then(|b| near_sdk::serde_json::from_slice::<String>(&b).ok());
        let pk: Option<[u8; 32]> = key_str.as_deref().and_then(|k| k.strip_prefix("ed25519:")).and_then(base58_decode).and_then(|v| v.try_into().ok());
        let Some(pk) = pk else { return false };
        if vault_key(&owner).is_some() {
            return true;
        }
        env::storage_write(&key(KEY_PREFIX, &owner), &pk);
        let n: u32 = env::storage_read(COUNT_KEY).and_then(|v| v.try_into().ok()).map(u32::from_le_bytes).unwrap_or(0);
        env::storage_write(&[INDEX_PREFIX, &n.to_le_bytes()].concat(), owner.as_bytes());
        env::storage_write(COUNT_KEY, &(n + 1).to_le_bytes());
        emit("near_vault_registered", near_sdk::serde_json::json!({"owner": owner, "account_id": eth::hex_encode(&pk)}));
        true
    }

    pub fn get_near_vault(&self, owner: AccountId) -> Option<NearVaultView> {
        let pk = vault_key(&owner)?;
        Some(NearVaultView { path: near_vault_path(&owner), public_key: format!("ed25519:{}", base58_encode(&pk)), account_id: eth::hex_encode(&pk) })
    }

    /// Owners with a NEAR vault, for executors (registration order).
    pub fn get_near_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, String)> {
        let n: u32 = env::storage_read(COUNT_KEY).and_then(|v| v.try_into().ok()).map(u32::from_le_bytes).unwrap_or(0);
        let from = from_index.unwrap_or(0);
        let end = n.min(from.saturating_add(limit.unwrap_or(100).min(200)));
        (from..end)
            .filter_map(|i| env::storage_read(&[INDEX_PREFIX, &i.to_le_bytes()].concat()))
            .filter_map(|b| String::from_utf8(b).ok()?.parse::<AccountId>().ok())
            .filter_map(|o| vault_key(&o).map(|pk| (o, eth::hex_encode(&pk))))
            .collect()
    }

    /// Asks MPC to sign a sweep of `amount` yoctoNEAR from the vault into the
    /// plan's escrow. Anyone may call it (executors do); the transaction can
    /// only be `deposit({owner})` on this contract. `block_hash` is base58.
    pub fn sweep_near_vault(&mut self, owner: AccountId, amount: U128, nonce: u64, block_hash: String) -> Promise {
        self.plan_ref(&owner);
        let pk = vault_key(&owner).unwrap_or_else(|| fail(Error::NoNearVault));
        let bh: [u8; 32] = base58_decode(&block_hash).and_then(|v| v.try_into().ok()).unwrap_or_else(|| fail(Error::InvalidSweep));
        if amount.0 == 0 || nonce == 0 {
            fail(Error::InvalidSweep);
        }
        let tx = sweep_tx(&env::current_account_id(), &owner, &pk, nonce, &bh, amount.0);
        let hash = env::sha256_array(&tx);
        let s = NearVaultSweep { nonce, amount, hash: eth::hex_encode(&hash), signed_tx: None, requested_at_ms: env::block_timestamp_ms() };
        env::storage_write(&key(SWEEP_PREFIX, &owner), &near_sdk::borsh::to_vec(&s).expect("borsh"));
        mpc::ext(self.mpc_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(MPC_SIGN_GAS)
            .sign(SignRequestArgs { payload_v2: SignPayload::Eddsa(eth::hex_encode(&hash)), path: near_vault_path(&owner), domain_id: MPC_DOMAIN_ED25519 })
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_near_vault_signed(owner, block_hash))
    }

    /// Keeps the signed sweep only if the signature verifies against the vault key.
    #[private]
    pub fn on_near_vault_signed(&mut self, owner: AccountId, block_hash: String) -> bool {
        let (Some(pk), Some(mut s)) = (vault_key(&owner), read_sweep(&owner)) else { return false };
        let resp = env::promise_result_checked(0, MAX_MPC_RESPONSE_BYTES).ok().and_then(|b| near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&b).ok());
        let Some(sig) = resp.as_ref().and_then(parse_ed25519) else {
            emit("near_vault_sign_failed", near_sdk::serde_json::json!({"owner": owner, "nonce": s.nonce}));
            return false;
        };
        let bh: [u8; 32] = base58_decode(&block_hash).and_then(|v| v.try_into().ok()).expect("checked");
        let tx = sweep_tx(&env::current_account_id(), &owner, &pk, s.nonce, &bh, s.amount.0);
        let hash = env::sha256_array(&tx);
        if eth::hex_encode(&hash) != s.hash || !env::ed25519_verify(&sig, hash, &pk) {
            emit("near_vault_sign_failed", near_sdk::serde_json::json!({"owner": owner, "nonce": s.nonce, "reason": "bad signature"}));
            return false;
        }
        let mut signed = tx;
        signed.push(0); // Signature::ED25519
        signed.extend(sig);
        use near_sdk::base64::Engine;
        s.signed_tx = Some(near_sdk::base64::engine::general_purpose::STANDARD.encode(&signed));
        env::storage_write(&key(SWEEP_PREFIX, &owner), &near_sdk::borsh::to_vec(&s).expect("borsh"));
        emit("near_vault_sweep_signed", near_sdk::serde_json::json!({"owner": owner, "nonce": s.nonce, "amount": s.amount}));
        true
    }

    pub fn get_near_vault_sweep(&self, owner: AccountId) -> Option<NearVaultSweep> {
        read_sweep(&owner)
    }
}
