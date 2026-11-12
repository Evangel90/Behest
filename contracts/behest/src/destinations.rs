//! D30: proof of control of a registered destination, and D31: a destination
//! update process while the owner is active.
//!
//! **Proof of control.** A recipient (heir, named alternate or the fallback)
//! proves it controls a destination, at setup or at claim:
//! - a NEAR account (a NEAR destination, or an Intents account that isn't
//!   `0x…`) by calling `prove_destination` from that account;
//! - an Ethereum address (`0x…`) with a `personal_sign` (EIP-191) signature;
//! - a Bitcoin testnet P2WPKH address (`tb1q…`, 20-byte program) with a
//!   Bitcoin "signed message" (BIP-137) signature. Taproot (`tb1p…`) needs
//!   BIP-322 Schnorr verification, which this contract doesn't do yet.
//!
//! The signed text names the contract, owner, recipient, chain and address,
//! so a proof can't be reused for another plan or address. A proof is
//! bound to that exact address: if the destination changes, it no longer
//! counts. Proofs are evidence shown to the owner, guardians and heirs; they
//! never block a release (a heir who lost a key has alternates/fallback).
//!
//! **Destination requests.** While the owner is active (no release open, not
//! overdue), a recipient may ask for a new destination on one chain, with a
//! proof of the new address. The owner approves or rejects; approving is an
//! ordinary owner edit, so the D28 edit notice applies. Nobody but the owner
//! can change a destination.
use near_sdk::{env, near, AccountId};

use crate::changes::{self, Change, ChangeKind};
use crate::errors::{fail, Error};
use crate::*;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestChain {
    Near,
    Eth,
    Btc,
    Intents,
}

impl DestChain {
    fn label(self) -> &'static str {
        match self {
            DestChain::Near => "NEAR",
            DestChain::Eth => "Ethereum",
            DestChain::Btc => "Bitcoin",
            DestChain::Intents => "NEAR Intents",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DestinationProof {
    pub account_id: AccountId,
    pub chain: DestChain,
    pub destination: String,
    pub proven_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DestinationRequest {
    pub account_id: AccountId,
    pub chain: DestChain,
    pub destination: String,
    pub requested_at_ms: u64,
}

/// One registered (or requested) destination and whether it is proven.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DestinationView {
    pub account_id: AccountId,
    pub chain: DestChain,
    pub destination: String,
    pub proven_at_ms: Option<u64>,
}

fn proofs_key(owner: &AccountId) -> Vec<u8> {
    [b"dprf:".as_slice(), owner.as_bytes()].concat()
}

fn requests_key(owner: &AccountId) -> Vec<u8> {
    [b"dreq:".as_slice(), owner.as_bytes()].concat()
}

fn read<T: near_sdk::borsh::BorshDeserialize + Default>(key: &[u8]) -> T {
    env::storage_read(key).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

fn write<T: near_sdk::borsh::BorshSerialize>(key: &[u8], v: &Vec<T>) {
    if v.is_empty() {
        env::storage_remove(key);
    } else {
        env::storage_write(key, &near_sdk::borsh::to_vec(v).expect("borsh"));
    }
}

pub fn proofs(owner: &AccountId) -> Vec<DestinationProof> {
    read(&proofs_key(owner))
}

pub fn requests(owner: &AccountId) -> Vec<DestinationRequest> {
    read(&requests_key(owner))
}

/// The exact text a recipient signs (EIP-191 or BIP-137) to prove control.
pub fn proof_message(owner: &AccountId, account: &AccountId, chain: DestChain, destination: &str) -> String {
    format!(
        "Behest destination proof\n\nI control this address and agree to receive through it.\nContract: {}\nPlan owner: {owner}\nRecipient: {account}\nChain: {}\nAddress: {destination}",
        env::current_account_id(),
        chain.label()
    )
}

/// BIP-137 `signmessage` hash: double SHA-256 of the magic prefix and the message.
fn bitcoin_message_hash(message: &str) -> [u8; 32] {
    fn varint(n: usize, out: &mut Vec<u8>) {
        if n < 0xfd {
            out.push(n as u8);
        } else {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
    }
    let magic = b"Bitcoin Signed Message:\n";
    let mut data = vec![];
    varint(magic.len(), &mut data);
    data.extend_from_slice(magic);
    varint(message.len(), &mut data);
    data.extend_from_slice(message.as_bytes());
    env::sha256_array(env::sha256_array(&data))
}

/// Checks a BIP-137 signature (65 bytes, hex: header ‖ r ‖ s) against a
/// P2WPKH address. Any compressed-key header (31–42) is accepted, since
/// wallets differ in which one they use for SegWit addresses.
fn verify_btc(message: &str, address: &str, signature: &str) {
    let script = btc::address_script(address).unwrap_or_else(|| fail(Error::InvalidDestination));
    if script.len() != 22 || script[0] != 0x00 || script[1] != 0x14 {
        fail(Error::DestinationProofUnsupported);
    }
    let sig = evm::hex_decode(signature.strip_prefix("0x").unwrap_or(signature)).filter(|b| b.len() == 65).unwrap_or_else(|| fail(Error::DestinationProof));
    let h = sig[0];
    if !(31..=42).contains(&h) {
        fail(Error::DestinationProof);
    }
    let recid = (h - 27) % 4;
    let pk = env::ecrecover(&bitcoin_message_hash(message), &sig[1..65], recid, false).unwrap_or_else(|| fail(Error::DestinationProof));
    let compressed = btc::compress(&pk).unwrap_or_else(|| fail(Error::DestinationProof));
    if btc::hash160(&compressed)[..] != script[2..] {
        fail(Error::DestinationProof);
    }
}

/// Verifies that the caller (or `signature`) controls `destination`.
fn verify(owner: &AccountId, account: &AccountId, chain: DestChain, destination: &str, signature: Option<&str>) {
    let msg = proof_message(owner, account, chain, destination);
    match chain {
        DestChain::Btc => verify_btc(&msg, destination, signature.unwrap_or_else(|| fail(Error::DestinationProof))),
        _ if policy::is_eth_address(destination) => {
            let sig = signature.unwrap_or_else(|| fail(Error::DestinationProof));
            if evm::recover(&msg, sig) != destination {
                fail(Error::DestinationProof);
            }
        }
        _ => {
            if caller().as_str() != destination {
                fail(Error::DestinationProof);
            }
        }
    }
}

/// Checks and normalizes a destination for a chain.
fn normalize(chain: DestChain, d: &str) -> String {
    let ok = match chain {
        DestChain::Near => d.parse::<AccountId>().is_ok(),
        DestChain::Eth => policy::is_eth_address(d),
        DestChain::Btc => btc::address_script(d).is_some(),
        DestChain::Intents => policy::is_eth_address(d) || d.parse::<AccountId>().is_ok(),
    };
    if !ok {
        fail(Error::InvalidDestination);
    }
    if policy::is_eth_address(d) {
        d.to_ascii_lowercase()
    } else {
        d.to_string()
    }
}

impl Contract {
    /// Heirs, then named alternates, then the fallback.
    fn recipients(&self, owner: &AccountId) -> Vec<AccountId> {
        let plan = self.plan_ref(owner);
        let mut out: Vec<AccountId> = plan.policy.heirs.iter().map(|h| h.account_id.clone()).collect();
        if let Some(r) = read_rules(owner) {
            out.extend(r.alternates.iter().map(|a| a.recipient.account_id.clone()));
            out.extend(r.fallback.iter().map(|f| f.account_id.clone()));
        }
        out
    }

    /// The destination registered now for `account` on `chain`.
    pub(crate) fn current_destination(&self, owner: &AccountId, account: &AccountId, chain: DestChain) -> Option<String> {
        let plan = self.plan_ref(owner);
        let rules = read_rules(owner).unwrap_or_default();
        let heir = plan.policy.heirs.iter().find(|h| &h.account_id == account);
        let other = rules.alternates.iter().map(|a| &a.recipient).chain(rules.fallback.iter()).find(|r| &r.account_id == account);
        let near = heir.and_then(|h| h.near_destination.clone()).or_else(|| other.and_then(|r| r.near_destination.clone()));
        match chain {
            DestChain::Near => near.map(|a| a.to_string()),
            DestChain::Eth => heir.and_then(|h| h.eth_destination.clone()).or_else(|| other.and_then(|r| r.eth_destination.clone())),
            DestChain::Btc => btc_dest(owner, account),
            DestChain::Intents => intents::deliveries(owner).into_iter().find(|d| &d.account_id == account && d.enabled).and_then(|d| d.intents_account.map(|a| a.to_string()).or(near.map(|a| a.to_string()))),
        }
    }

    fn record_proof(&mut self, owner: &AccountId, account: &AccountId, chain: DestChain, destination: &str) {
        let mut v = proofs(owner);
        let t = env::block_timestamp_ms();
        match v.iter_mut().find(|p| &p.account_id == account && p.chain == chain && p.destination == destination) {
            Some(p) => p.proven_at_ms = t,
            None => v.push(DestinationProof { account_id: account.clone(), chain, destination: destination.to_string(), proven_at_ms: t }),
        }
        self.prune(owner, &mut v);
        write(&proofs_key(owner), &v);
        emit("destination_proven", near_sdk::serde_json::json!({"owner": owner, "account_id": account, "chain": chain, "destination": destination}));
    }

    /// Keeps proofs of current, requested and queued (D28) destinations only,
    /// so storage stays bounded.
    fn prune(&self, owner: &AccountId, v: &mut Vec<DestinationProof>) {
        let reqs = requests(owner);
        let queued = near_sdk::serde_json::to_string(&changes::pending(owner)).unwrap_or_default();
        v.retain(|p| {
            self.current_destination(owner, &p.account_id, p.chain).as_deref() == Some(p.destination.as_str())
                || reqs.iter().any(|r| r.account_id == p.account_id && r.chain == p.chain && r.destination == p.destination)
                || queued.contains(&format!("\"{}\"", p.destination))
        });
    }

    /// The owner edit that sets `account`'s destination on `chain`, built on
    /// top of a pending change of the same kind if there is one.
    fn destination_change(&self, owner: &AccountId, account: &AccountId, chain: DestChain, dest: &str) -> Change {
        let pending = |k: ChangeKind| changes::pending(owner).into_iter().find(|c| c.change.kind() == k).map(|c| c.change);
        let plan = self.plan_ref(owner);
        let is_heir = plan.policy.heirs.iter().any(|h| &h.account_id == account);
        match chain {
            DestChain::Near | DestChain::Eth if is_heir => {
                let mut p = match pending(ChangeKind::Plan) {
                    Some(Change::Plan(p)) => p,
                    _ => plan.policy.clone(),
                };
                changes::copy_timers(&mut p, &plan.policy);
                let h = p.heirs.iter_mut().find(|h| &h.account_id == account).unwrap_or_else(|| fail(Error::NotRecipient));
                if chain == DestChain::Near {
                    h.near_destination = Some(dest.parse().unwrap_or_else(|_| fail(Error::InvalidDestination)));
                } else {
                    h.eth_destination = Some(dest.to_string());
                }
                Change::Plan(p)
            }
            DestChain::Near | DestChain::Eth => {
                let mut r = match pending(ChangeKind::Rules) {
                    Some(Change::Rules(Some(r))) => r,
                    _ => read_rules(owner).unwrap_or_else(|| fail(Error::NotRecipient)),
                };
                let rec = r.alternates.iter_mut().map(|a| &mut a.recipient).chain(r.fallback.iter_mut()).find(|x| &x.account_id == account).unwrap_or_else(|| fail(Error::NotRecipient));
                if chain == DestChain::Near {
                    rec.near_destination = Some(dest.parse().unwrap_or_else(|_| fail(Error::InvalidDestination)));
                } else {
                    rec.eth_destination = Some(dest.to_string());
                }
                Change::Rules(Some(r))
            }
            DestChain::Btc => {
                let mut d = match pending(ChangeKind::Btc) {
                    Some(Change::Btc(d)) => d,
                    _ => btc_dests(owner),
                };
                match d.iter_mut().find(|x| &x.account_id == account) {
                    Some(x) => x.address = dest.to_string(),
                    None => d.push(BtcDestination { account_id: account.clone(), address: dest.to_string() }),
                }
                Change::Btc(d)
            }
            DestChain::Intents => {
                let mut d = match pending(ChangeKind::Intents) {
                    Some(Change::Intents(d)) => d,
                    _ => intents::deliveries(owner),
                };
                let x = d.iter_mut().find(|x| &x.account_id == account && x.enabled).unwrap_or_else(|| fail(Error::InvalidDestination));
                x.intents_account = Some(dest.parse().unwrap_or_else(|_| fail(Error::InvalidDestination)));
                Change::Intents(d)
            }
        }
    }
}

#[near]
impl Contract {
    /// D30. The text to sign for a proof (for wallets and the app).
    pub fn get_proof_message(&self, owner: AccountId, account_id: AccountId, chain: DestChain, destination: String) -> String {
        proof_message(&owner, &account_id, chain, &normalize(chain, &destination))
    }

    /// D30. Proves control of `destination`, which must be `account_id`'s
    /// current destination on `chain` or one it has requested. NEAR accounts
    /// prove by calling from that account; `0x…` and Bitcoin addresses by
    /// `signature` (hex) over `get_proof_message`, submitted by anyone.
    pub fn prove_destination(&mut self, owner: AccountId, account_id: AccountId, chain: DestChain, destination: String, signature: Option<String>) {
        let destination = normalize(chain, &destination);
        let current = self.current_destination(&owner, &account_id, chain).as_deref() == Some(destination.as_str());
        let requested = requests(&owner).iter().any(|r| r.account_id == account_id && r.chain == chain && r.destination == destination);
        if !current && !requested {
            fail(Error::InvalidDestination);
        }
        verify(&owner, &account_id, chain, &destination, signature.as_deref());
        self.record_proof(&owner, &account_id, chain, &destination);
    }

    /// D30. Every current destination (and every requested one) with its proof status.
    pub fn get_destinations(&self, owner: AccountId) -> Vec<DestinationView> {
        let pr = proofs(&owner);
        let proven = |a: &AccountId, c: DestChain, d: &str| pr.iter().find(|p| &p.account_id == a && p.chain == c && p.destination == d).map(|p| p.proven_at_ms);
        let mut out = vec![];
        for a in self.recipients(&owner) {
            for c in [DestChain::Near, DestChain::Eth, DestChain::Btc, DestChain::Intents] {
                if let Some(d) = self.current_destination(&owner, &a, c) {
                    out.push(DestinationView { proven_at_ms: proven(&a, c, &d), account_id: a.clone(), chain: c, destination: d });
                }
            }
        }
        out
    }

    pub fn get_destination_requests(&self, owner: AccountId) -> Vec<DestinationView> {
        let pr = proofs(&owner);
        requests(&owner)
            .into_iter()
            .map(|r| DestinationView {
                proven_at_ms: pr.iter().find(|p| p.account_id == r.account_id && p.chain == r.chain && p.destination == r.destination).map(|p| p.proven_at_ms),
                account_id: r.account_id,
                chain: r.chain,
                destination: r.destination,
            })
            .collect()
    }

    /// D31. A recipient asks the owner for a new destination on one chain,
    /// optionally proving it at once (`signature`, or calling from the new
    /// NEAR account). Only while the owner is active; one request per chain.
    pub fn request_destination_change(&mut self, owner: AccountId, chain: DestChain, destination: String, signature: Option<String>) {
        let me = caller();
        if !self.recipients(&owner).contains(&me) {
            fail(Error::NotRecipient);
        }
        if status_of(&self.plan_ref(&owner), env::block_timestamp_ms()) != PlanStatus::Active {
            fail(Error::OwnerNotActive);
        }
        let destination = normalize(chain, &destination);
        if chain == DestChain::Intents && self.current_destination(&owner, &me, chain).is_none() {
            fail(Error::InvalidDestination);
        }
        if self.current_destination(&owner, &me, chain).as_deref() == Some(destination.as_str()) {
            fail(Error::InvalidDestination);
        }
        let mut v = requests(&owner);
        v.retain(|r| !(r.account_id == me && r.chain == chain));
        v.push(DestinationRequest { account_id: me.clone(), chain, destination: destination.clone(), requested_at_ms: env::block_timestamp_ms() });
        write(&requests_key(&owner), &v);
        emit("destination_change_requested", near_sdk::serde_json::json!({"owner": owner, "account_id": me, "chain": chain, "destination": destination}));
        let self_proof = !policy::is_eth_address(&destination) && chain != DestChain::Btc && destination == me.as_str();
        if signature.is_some() || self_proof {
            verify(&owner, &me, chain, &destination, signature.as_deref());
            self.record_proof(&owner, &me, chain, &destination);
        } else {
            let mut p = proofs(&owner);
            self.prune(&owner, &mut p);
            write(&proofs_key(&owner), &p);
        }
    }

    /// D31. The requester withdraws its request.
    pub fn cancel_destination_change(&mut self, owner: AccountId, chain: DestChain) {
        let me = caller();
        let mut v = requests(&owner);
        let n = v.len();
        v.retain(|r| !(r.account_id == me && r.chain == chain));
        if v.len() == n {
            fail(Error::NoDestinationRequest);
        }
        write(&requests_key(&owner), &v);
        emit("destination_change_withdrawn", near_sdk::serde_json::json!({"owner": owner, "account_id": me, "chain": chain}));
    }

    /// D31 (owner). Approves (an owner edit: the edit notice applies, so it
    /// may be queued) or rejects a recipient's destination request.
    #[payable]
    pub fn respond_destination_change(&mut self, account_id: AccountId, chain: DestChain, approve: bool) {
        let owner = caller();
        let before = env::storage_usage();
        let mut v = requests(&owner);
        let r = v.iter().find(|r| r.account_id == account_id && r.chain == chain).cloned().unwrap_or_else(|| fail(Error::NoDestinationRequest));
        let mut queued = false;
        if approve {
            let change = self.destination_change(&owner, &account_id, chain, &r.destination);
            queued = self.apply_or_queue(&owner, change);
        }
        v.retain(|x| !(x.account_id == account_id && x.chain == chain));
        write(&requests_key(&owner), &v);
        let mut p = proofs(&owner);
        self.prune(&owner, &mut p);
        write(&proofs_key(&owner), &p);
        emit(
            if approve { "destination_change_approved" } else { "destination_change_rejected" },
            near_sdk::serde_json::json!({"owner": owner, "account_id": account_id, "chain": chain, "destination": r.destination, "queued": queued}),
        );
        self.charge_storage(before, &owner, false);
    }
}
