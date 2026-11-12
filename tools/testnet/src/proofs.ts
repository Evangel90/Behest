// D30 helpers: the proof text the contract checks, and BIP-137 Bitcoin
// "signed message" signatures (what Electrum/Sparrow produce) for tb1q keys.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

export type DestChain = "Near" | "Eth" | "Btc" | "Intents";
const LABEL: Record<DestChain, string> = { Near: "NEAR", Eth: "Ethereum", Btc: "Bitcoin", Intents: "NEAR Intents" };

/** Must match contracts/behest/src/destinations.rs `proof_message` (also served by `get_proof_message`). */
export function proofMessage(contract: string, owner: string, account: string, chain: DestChain, destination: string): string {
  return `Behest destination proof\n\nI control this address and agree to receive through it.\nContract: ${contract}\nPlan owner: ${owner}\nRecipient: ${account}\nChain: ${LABEL[chain]}\nAddress: ${destination}`;
}

function varint(n: number): number[] {
  return n < 0xfd ? [n] : [0xfd, n & 0xff, n >> 8];
}

export function bitcoinMessageHash(message: string): Uint8Array {
  const magic = new TextEncoder().encode("Bitcoin Signed Message:\n");
  const m = new TextEncoder().encode(message);
  const data = new Uint8Array([...varint(magic.length), ...magic, ...varint(m.length), ...m]);
  return sha256(sha256(data));
}

/** BIP-137 signature for a P2WPKH key, as 65 bytes hex (header 39–42 ‖ r ‖ s). */
export function signBitcoinMessage(message: string, priv: Uint8Array): string {
  const s = secp256k1.sign(bitcoinMessageHash(message), priv, { prehash: false, format: "recovered" } as never) as Uint8Array;
  const out = new Uint8Array(65);
  out[0] = 39 + s[0]!;
  out.set(s.slice(1), 1);
  return hex.encode(out);
}
