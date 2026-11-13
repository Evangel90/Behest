// D30 helpers shared by the destination cards (pure, unit-tested).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DestChain } from "./types";

export const CHAIN_LABEL: Record<DestChain, string> = { Near: "NEAR", Eth: "Ethereum", Btc: "Bitcoin", Intents: "NEAR Intents" };
const ETH = /^0x[0-9a-fA-F]{40}$/;

/** How a destination is proven: from the NEAR account, an Ethereum signature, or a Bitcoin signed message. */
export type How = "near" | "eth" | "btc" | "taproot";
export function proofHow(chain: DestChain, d: string): How {
  if (chain === "Btc") return d.startsWith("tb1q") || d.startsWith("bc1q") ? "btc" : "taproot";
  return ETH.test(d) ? "eth" : "near";
}

/** A BIP-137 signature as wallets show it (base64), or hex, to the 65-byte hex the contract reads. */
export function sigHex(s: string): string | null {
  const t = s.trim();
  if (/^(0x)?[0-9a-fA-F]{130}$/.test(t)) return t.replace(/^0x/, "");
  try {
    const b = atob(t);
    if (b.length !== 65) return null;
    return Array.from(b, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}


const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const varint = (n: number) => (n < 0xfd ? [n] : [0xfd, n & 0xff, n >> 8]);

/** What a Bitcoin wallet signs for "Sign message": the double SHA-256 of the prefixed text (same as the contract's `bitcoin_message_hash`). */
export function bitcoinMessageHash(message: string): Uint8Array {
  const magic = new TextEncoder().encode("Bitcoin Signed Message:\n");
  const m = new TextEncoder().encode(message);
  return sha256(sha256(Uint8Array.from([...varint(magic.length), ...magic, ...varint(m.length), ...m])));
}

/**
 * A BIP-137 signature (65 bytes hex: header ‖ r ‖ s) from a bare r ‖ s, for a
 * signer that returns no recovery id (the email account's Bitcoin key signs a
 * hash and nothing else). The id is found by trying each and keeping the one
 * that recovers this key; the header is the P2WPKH one (39–42). Null if the
 * signature isn't this key's.
 */
export function bip137(rs: Uint8Array, digest: Uint8Array, publicKeyHex: string): string | null {
  if (rs.length !== 64) return null;
  const want = publicKeyHex.replace(/^0x/, "").toLowerCase();
  for (let recid = 0; recid < 4; recid++) {
    try {
      const pk = secp256k1.recoverPublicKey(Uint8Array.from([recid, ...rs]), digest, { prehash: false });
      if (hexOf(pk) === want) return hexOf(Uint8Array.from([39 + recid, ...rs]));
    } catch {}
  }
  return null;
}
