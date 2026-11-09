//! D22: proving how a Sepolia transaction ended, without trusting anyone.
//!
//! A proof is the block header (RLP), the transaction's index in the block,
//! and Merkle-Patricia proofs of the transaction and its receipt against the
//! header's `transactionsRoot` and `receiptsRoot`. `verify_outcome` checks the
//! proofs and returns the header's hash; the caller then asks the Ethereum
//! light client on NEAR whether that is the finalized hash at that height.

use near_sdk::env;

fn keccak(b: &[u8]) -> [u8; 32] {
    env::keccak256_array(b)
}

/// One decoded RLP item. Lists keep their raw encoding (an MPT node that is
/// shorter than 32 bytes is embedded in its parent instead of hashed).
#[derive(Debug, Clone, PartialEq)]
pub enum Rlp<'a> {
    Bytes(&'a [u8]),
    List(Vec<Rlp<'a>>, &'a [u8]),
}

impl<'a> Rlp<'a> {
    pub fn bytes(&self) -> Option<&'a [u8]> {
        match self {
            Rlp::Bytes(b) => Some(b),
            Rlp::List(..) => None,
        }
    }
    pub fn list(&self) -> Option<&[Rlp<'a>]> {
        match self {
            Rlp::List(v, _) => Some(v),
            Rlp::Bytes(_) => None,
        }
    }
}

fn be_len(b: &[u8]) -> Option<usize> {
    if b.is_empty() || b.len() > 4 || b[0] == 0 {
        return None;
    }
    Some(b.iter().fold(0usize, |a, x| (a << 8) | *x as usize))
}

/// Decodes the item at the start of `b`; returns it and the bytes it used.
fn decode_one(b: &[u8]) -> Option<(Rlp<'_>, usize)> {
    let p = *b.first()?;
    let (payload, start, is_list) = match p {
        0x00..=0x7f => return Some((Rlp::Bytes(&b[..1]), 1)),
        0x80..=0xb7 => ((p - 0x80) as usize, 1, false),
        0xb8..=0xbf => {
            let n = (p - 0xb7) as usize;
            (be_len(b.get(1..1 + n)?)?, 1 + n, false)
        }
        0xc0..=0xf7 => ((p - 0xc0) as usize, 1, true),
        0xf8..=0xff => {
            let n = (p - 0xf7) as usize;
            (be_len(b.get(1..1 + n)?)?, 1 + n, true)
        }
    };
    let end = start.checked_add(payload)?;
    let body = b.get(start..end)?;
    if !is_list {
        // canonical: a single byte below 0x80 is encoded as itself
        if payload == 1 && body[0] < 0x80 && start == 1 {
            return None;
        }
        return Some((Rlp::Bytes(body), end));
    }
    let mut items = vec![];
    let mut at = 0;
    while at < body.len() {
        let (item, used) = decode_one(&body[at..])?;
        items.push(item);
        at += used;
    }
    Some((Rlp::List(items, &b[..end]), end))
}

/// Decodes exactly one item filling all of `b`.
pub fn decode(b: &[u8]) -> Option<Rlp<'_>> {
    let (item, used) = decode_one(b)?;
    (used == b.len()).then_some(item)
}

/// RLP of an unsigned integer (the trie key of a transaction index).
pub fn rlp_index(i: u64) -> Vec<u8> {
    if i == 0 {
        return vec![0x80];
    }
    let be = i.to_be_bytes();
    let b = &be[be.iter().position(|x| *x != 0).unwrap_or(7)..];
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = vec![0x80 + b.len() as u8];
    out.extend_from_slice(b);
    out
}

fn nibbles(b: &[u8]) -> Vec<u8> {
    b.iter().flat_map(|x| [x >> 4, x & 0x0f]).collect()
}

/// Hex-prefix decoding of a leaf/extension path: (nibbles, is_leaf).
fn hp(b: &[u8]) -> Option<(Vec<u8>, bool)> {
    let n = nibbles(b);
    let flag = *n.first()?;
    let leaf = flag >= 2;
    let odd = flag % 2 == 1;
    if flag > 3 || (!odd && n.get(1) != Some(&0)) {
        return None;
    }
    Some((n[if odd { 1 } else { 2 }..].to_vec(), leaf))
}

/// Verifies `proof` (root node first) for `key` against `root`; returns the
/// value stored there. Fails on any mismatch, including proofs of absence.
pub fn verify_proof(root: &[u8; 32], key: &[u8], proof: &[Vec<u8>]) -> Option<Vec<u8>> {
    let key = nibbles(key);
    let mut at = 0usize;
    let mut i = 0usize;
    // The next node: by hash (from the proof) or embedded in its parent.
    let mut want_hash: Option<[u8; 32]> = Some(*root);
    let mut embedded: Option<Vec<u8>> = None;
    loop {
        let raw: Vec<u8> = match (want_hash, embedded.take()) {
            (Some(h), _) => {
                let n = proof.get(i)?;
                i += 1;
                if keccak(n) != h {
                    return None;
                }
                n.clone()
            }
            (None, Some(e)) => e,
            (None, None) => return None,
        };
        let node = decode(&raw)?;
        let items = node.list()?;
        let next: &Rlp = match items.len() {
            17 => {
                if at == key.len() {
                    let v = items[16].bytes()?;
                    return (!v.is_empty() && i == proof.len()).then(|| v.to_vec());
                }
                let c = &items[key[at] as usize];
                at += 1;
                c
            }
            2 => {
                let (path, leaf) = hp(items[0].bytes()?)?;
                if key.get(at..at + path.len())? != path.as_slice() {
                    return None;
                }
                at += path.len();
                if leaf {
                    return (at == key.len() && i == proof.len()).then(|| items[1].bytes().map(|v| v.to_vec())).flatten();
                }
                &items[1]
            }
            _ => return None,
        };
        match next {
            Rlp::Bytes(h) if h.len() == 32 => {
                want_hash = Some((*h).try_into().ok()?);
            }
            Rlp::List(_, r) => {
                want_hash = None;
                embedded = Some(r.to_vec());
            }
            _ => return None, // empty slot: the key isn't in the trie
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub block_number: u64,
    pub block_hash: [u8; 32],
    pub tx_hash: [u8; 32],
    /// Receipt status: true = success, false = reverted.
    pub success: bool,
}

/// Checks the transaction and receipt proofs against the header and returns
/// what they prove. The header itself is trusted only once the light client
/// confirms its hash.
pub fn verify_outcome(header: &[u8], index: u64, tx_proof: &[Vec<u8>], receipt_proof: &[Vec<u8>]) -> Result<Outcome, &'static str> {
    let h = decode(header).ok_or("header rlp")?;
    let f = h.list().ok_or("header rlp")?;
    if f.len() < 15 {
        return Err("header fields");
    }
    let root = |i: usize| -> Result<[u8; 32], &'static str> { f[i].bytes().and_then(|b| b.try_into().ok()).ok_or("header root") };
    let (tx_root, receipt_root) = (root(4)?, root(5)?);
    let num = f[8].bytes().ok_or("header number")?;
    if num.len() > 8 || num.first() == Some(&0) {
        return Err("header number");
    }
    let block_number = num.iter().fold(0u64, |a, x| (a << 8) | *x as u64);
    let key = rlp_index(index);
    let tx = verify_proof(&tx_root, &key, tx_proof).ok_or("transaction proof")?;
    let receipt = verify_proof(&receipt_root, &key, receipt_proof).ok_or("receipt proof")?;
    // EIP-2718: a typed receipt is its type byte followed by the RLP list.
    let body = match receipt.first() {
        Some(t) if *t < 0x7f => &receipt[1..],
        Some(_) => &receipt[..],
        None => return Err("receipt"),
    };
    let r = decode(body).ok_or("receipt rlp")?;
    let status = r.list().and_then(|l| l.first()).and_then(|s| s.bytes()).ok_or("receipt status")?;
    let success = match status {
        [] => false,
        [1] => true,
        _ => return Err("receipt status"),
    };
    Ok(Outcome { block_number, block_hash: keccak(header), tx_hash: keccak(&tx), success })
}
