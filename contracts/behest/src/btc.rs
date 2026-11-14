//! Minimal Bitcoin (testnet) transaction encoding for vault payouts.
//! See docs/spec/03-signing-boundary.md. Dependency-free so every byte the
//! MPC network signs is visible here, like `eth.rs`.
//!
//! The vault is a P2WPKH output of the plan's MPC key. Payouts are version-2,
//! RBF-signalling SegWit transactions; each input is signed separately with
//! the BIP143 digest (SIGHASH_ALL).

use near_sdk::env;

pub const SEQUENCE_RBF: u32 = 0xffff_fffd;
/// Below this an output is non-standard ("dust") for P2WPKH/P2TR receivers.
pub const DUST: u64 = 330;
/// Testnet human-readable part (testnet3, testnet4 and signet share it).
pub const HRP: &str = "tb";

pub struct Input {
    /// Txid in display order (as explorers show it).
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
}

pub struct Output {
    pub script: Vec<u8>,
    pub value: u64,
}

pub struct Tx {
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
}

fn dsha(b: &[u8]) -> [u8; 32] {
    env::sha256_array(&env::sha256_array(b))
}

fn varint(n: usize, out: &mut Vec<u8>) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend((n as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend((n as u32).to_le_bytes());
        }
    }
}

fn outpoint(i: &Input, out: &mut Vec<u8>) {
    let mut le = i.txid;
    le.reverse();
    out.extend(le);
    out.extend(i.vout.to_le_bytes());
}

fn outputs(o: &[Output], out: &mut Vec<u8>) {
    for x in o {
        out.extend(x.value.to_le_bytes());
        varint(x.script.len(), out);
        out.extend(&x.script);
    }
}

impl Tx {
    /// Legacy (witness-free) serialization: the txid preimage.
    fn base(&self) -> Vec<u8> {
        let mut b = 2u32.to_le_bytes().to_vec();
        varint(self.inputs.len(), &mut b);
        for i in &self.inputs {
            outpoint(i, &mut b);
            b.push(0); // empty scriptSig
            b.extend(SEQUENCE_RBF.to_le_bytes());
        }
        varint(self.outputs.len(), &mut b);
        outputs(&self.outputs, &mut b);
        b.extend(0u32.to_le_bytes()); // locktime
        b
    }

    /// Txid in display order. SegWit txids exclude witnesses, so this is known
    /// before signing and a child transaction can spend this one's change.
    pub fn txid(&self) -> [u8; 32] {
        let mut h = dsha(&self.base());
        h.reverse();
        h
    }

    /// BIP143 digest for input `i` spending a P2WPKH output of `pkh`.
    pub fn sighash(&self, i: usize, pkh: &[u8; 20]) -> [u8; 32] {
        let mut prev = vec![];
        let mut seq = vec![];
        for x in &self.inputs {
            outpoint(x, &mut prev);
            seq.extend(SEQUENCE_RBF.to_le_bytes());
        }
        let mut outs = vec![];
        outputs(&self.outputs, &mut outs);
        let mut p = 2u32.to_le_bytes().to_vec();
        p.extend(dsha(&prev));
        p.extend(dsha(&seq));
        outpoint(&self.inputs[i], &mut p);
        p.extend([0x19, 0x76, 0xa9, 0x14]);
        p.extend(pkh);
        p.extend([0x88, 0xac]);
        p.extend(self.inputs[i].value.to_le_bytes());
        p.extend(SEQUENCE_RBF.to_le_bytes());
        p.extend(dsha(&outs));
        p.extend(0u32.to_le_bytes());
        p.extend(1u32.to_le_bytes()); // SIGHASH_ALL
        dsha(&p)
    }

    /// Fully signed SegWit serialization; `sigs[i]` is DER + sighash byte.
    pub fn signed(&self, pubkey: &[u8; 33], sigs: &[Vec<u8>]) -> Vec<u8> {
        let base = self.base();
        let mut b = base[..4].to_vec();
        b.extend([0x00, 0x01]); // segwit marker + flag
        b.extend(&base[4..base.len() - 4]);
        for s in sigs {
            b.push(2);
            varint(s.len(), &mut b);
            b.extend(s);
            b.push(33);
            b.extend(pubkey);
        }
        b.extend(0u32.to_le_bytes());
        b
    }
}

/// Virtual size upper bound of a transaction with `n` P2WPKH inputs and the
/// given output scripts (signatures assumed 72 bytes). Used for fees/reserves.
pub fn vsize(n: usize, scripts: &[usize]) -> u64 {
    // non-witness: 4 version + 1 in-count + n*(36+1+4) + 1 out-count + outs + 4 locktime
    let base = 10 + 41 * n + scripts.iter().map(|l| 9 + l).sum::<usize>();
    // witness: 2 marker/flag + n*(1 + 1+72 + 1+33)
    let witness = 2 + 108 * n;
    ((base * 4 + witness).div_ceil(4)) as u64
}

pub fn hash160(b: &[u8]) -> [u8; 20] {
    env::ripemd160_array(&env::sha256_array(b))
}

pub fn p2wpkh_script(pkh: &[u8; 20]) -> Vec<u8> {
    let mut s = vec![0x00, 0x14];
    s.extend(pkh);
    s
}

/// Compresses a 64-byte uncompressed `x || y` public key.
pub fn compress(xy: &[u8]) -> Option<[u8; 33]> {
    if xy.len() != 64 {
        return None;
    }
    let mut out = [0u8; 33];
    out[0] = if xy[63] & 1 == 0 { 2 } else { 3 };
    out[1..].copy_from_slice(&xy[..32]);
    Some(out)
}

const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2,
    0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if d < 0 { 1 } else { 0 };
        if d < 0 {
            d += 256;
        }
        out[i] = d as u8;
    }
    out
}

fn der_int(x: &[u8; 32], out: &mut Vec<u8>) {
    let start = x.iter().position(|b| *b != 0).unwrap_or(31);
    let v = &x[start..];
    let pad = v[0] & 0x80 != 0;
    out.push(0x02);
    out.push((v.len() + pad as usize) as u8);
    if pad {
        out.push(0);
    }
    out.extend(v);
}

/// DER signature (low-S, as Bitcoin relay policy requires) + SIGHASH_ALL.
pub fn der_sig(r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
    let mut half = [0u8; 32];
    // N >> 1
    let mut carry = 0u8;
    for i in 0..32 {
        half[i] = (N[i] >> 1) | carry;
        carry = (N[i] & 1) << 7;
    }
    let s = if s > &half { sub(&N, s) } else { *s };
    let mut body = vec![];
    der_int(r, &mut body);
    der_int(&s, &mut body);
    let mut out = vec![0x30, body.len() as u8];
    out.extend(body);
    out.push(0x01);
    out
}

// ------------------------------------------------------------ bech32 / m

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M: u32 = 0x2bc8_30a3;

fn polymod(values: &[u8]) -> u32 {
    const G: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk: u32 = 1;
    for v in values {
        let b = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ *v as u32;
        for (i, g) in G.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|b| b >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|b| b & 31));
    v
}

fn convert(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let (mut acc, mut bits, mut out) = (0u32, 0u32, vec![]);
    let maxv = (1 << to) - 1;
    for d in data {
        if (*d as u32) >> from != 0 {
            return None;
        }
        acc = (acc << from) | *d as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return None;
    }
    Some(out)
}

/// Output script of a testnet SegWit address: v0 (P2WPKH, P2WSH, bech32) or
/// v1 (P2TR, bech32m). Lowercase only; anything else is refused.
pub fn address_script(addr: &str) -> Option<Vec<u8>> {
    let (hrp, data) = addr.rsplit_once('1')?;
    if hrp != HRP || addr.bytes().any(|b| b.is_ascii_uppercase()) || data.len() < 7 || addr.len() > 90 {
        return None;
    }
    let vals: Vec<u8> = data.bytes().map(|c| CHARSET.iter().position(|x| *x == c).map(|p| p as u8)).collect::<Option<_>>()?;
    let mut chk = hrp_expand(hrp);
    chk.extend(&vals);
    let constant = polymod(&chk);
    let payload = &vals[..vals.len() - 6];
    let (version, prog5) = payload.split_first()?;
    let program = convert(prog5, 5, 8, false)?;
    let ok = match (version, program.len()) {
        (0, 20) | (0, 32) => constant == 1,
        (1, 32) => constant == BECH32M,
        _ => false,
    };
    if !ok {
        return None;
    }
    let mut s = vec![if *version == 0 { 0x00 } else { 0x51 }, program.len() as u8];
    s.extend(program);
    Some(s)
}

/// Testnet bech32 address of a P2WPKH key hash (for views).
pub fn p2wpkh_address(pkh: &[u8; 20]) -> String {
    let mut data = vec![0u8];
    data.extend(convert(pkh, 8, 5, true).expect("8->5"));
    let mut chk = hrp_expand(HRP);
    chk.extend(&data);
    chk.extend([0u8; 6]);
    let m = polymod(&chk) ^ 1;
    let mut s = format!("{HRP}1");
    for d in data.iter().copied().chain((0..6).map(|i| ((m >> (5 * (5 - i))) & 31) as u8)) {
        s.push(CHARSET[d as usize] as char);
    }
    s
}
