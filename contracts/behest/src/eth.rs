//! Minimal EIP-1559 transaction encoding for plain ETH transfers.
//! See docs/stage0/03-signing-boundary.md. Kept dependency-free so every
//! byte the MPC network signs is visible in this file.

use near_sdk::env;

pub const GAS_LIMIT: u128 = 21_000;

/// Fields of a type-2 transaction with empty `data` and `access_list`.
pub struct EthTransfer<'a> {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub to: &'a [u8; 20],
    pub value: u128,
}

pub struct RsvSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

impl EthTransfer<'_> {
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas),
            rlp_uint(self.max_fee_per_gas),
            rlp_uint(GAS_LIMIT),
            rlp_bytes(self.to),
            rlp_uint(self.value),
            rlp_bytes(&[]),  // data
            rlp_list(&[]),   // access_list
        ]
    }

    /// `0x02 || rlp([...fields])`: the preimage of the signing hash.
    pub fn unsigned(&self) -> Vec<u8> {
        let mut out = vec![0x02];
        out.extend(rlp_list(&self.fields()));
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        env::keccak256_array(&self.unsigned())
    }

    /// Raw transaction ready for `eth_sendRawTransaction`.
    pub fn signed(&self, sig: &RsvSignature) -> Vec<u8> {
        let mut f = self.fields();
        f.push(rlp_uint(sig.y_parity as u128));
        f.push(rlp_bytes(strip_zeros(&sig.r)));
        f.push(rlp_bytes(strip_zeros(&sig.s)));
        let mut out = vec![0x02];
        out.extend(rlp_list(&f));
        out
    }
}

fn strip_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[i..]
}

fn rlp_uint(v: u128) -> Vec<u8> {
    rlp_bytes(strip_zeros(&v.to_be_bytes()))
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut out = rlp_len(body.len(), 0xc0);
    out.extend(body);
    out
}

fn rlp_len(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        vec![offset + len as u8]
    } else {
        let be = (len as u64).to_be_bytes();
        let l = strip_zeros(&be);
        let mut out = vec![offset + 55 + l.len() as u8];
        out.extend_from_slice(l);
        out
    }
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let v = hex_decode(s.strip_prefix("0x")?)?;
    v.try_into().ok()
}

pub fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// Fee after one replacement bump: at least +12.5% (geth's replacement rule),
/// never above `cap`.
pub fn bump(fee: u128, cap: u128) -> u128 {
    let bumped = fee + (fee + 7) / 8;
    bumped.max(fee + 1).min(cap)
}
