import { describe, expect, it } from "vitest";
import { proofHow, sigHex } from "../src/lib/destinations";

describe("D30 proof helpers", () => {
  it("reads BIP-137 signatures as wallets show them (base64) or hex", () => {
    const hex = "27" + "ab".repeat(64);
    const b64 = btoa(String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16))));
    expect(sigHex(b64)).toBe(hex);
    expect(sigHex(`0x${hex}`)).toBe(hex);
    expect(sigHex("not a signature")).toBeNull();
    expect(sigHex(btoa("short"))).toBeNull();
  });
  it("picks how a destination is proven", () => {
    expect(proofHow("Near", "amara.testnet")).toBe("near");
    expect(proofHow("Intents", "0x" + "a".repeat(40))).toBe("eth");
    expect(proofHow("Btc", "tb1qxyz")).toBe("btc");
    expect(proofHow("Btc", "tb1pxyz")).toBe("taproot");
  });
});

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bip137, bitcoinMessageHash } from "../src/lib/destinations";
// The testnet tools' signer: its signatures are the ones the live contract accepted (e2e-destinations).
import { bitcoinMessageHash as referenceHash, proofMessage, signBitcoinMessage } from "../../../tools/testnet/src/proofs";

describe("a Bitcoin signed message from a key that only signs hashes", () => {
  const priv = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const pub = hex(secp256k1.getPublicKey(priv, true));
  const text = proofMessage("behest.testnet", "kemi.testnet", "0x" + "a".repeat(40), "Btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");

  it("hashes the text the way Bitcoin wallets and the contract do", () => {
    for (const m of ["hello", text, "x".repeat(300)]) expect(hex(bitcoinMessageHash(m))).toBe(hex(referenceHash(m)));
  });

  it("rebuilds the signature a wallet holding the key would have produced", () => {
    const digest = bitcoinMessageHash(text);
    const expected = signBitcoinMessage(text, priv); // header ‖ r ‖ s
    // the email account's key returns r ‖ s only
    const rs = Uint8Array.from(expected.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
    expect(bip137(rs, digest, pub)).toBe(expected);
    expect(bip137(rs, digest, `0x${pub}`)).toBe(expected);
    expect(parseInt(expected.slice(0, 2), 16)).toBeGreaterThanOrEqual(39);
    // someone else's signature, a mangled one, or another message is refused
    const other = signBitcoinMessage(text, Uint8Array.from({ length: 32 }, () => 5));
    expect(bip137(Uint8Array.from(other.slice(2).match(/../g)!.map((b) => parseInt(b, 16))), digest, pub)).toBeNull();
    expect(bip137(rs.slice(0, 60), digest, pub)).toBeNull();
    expect(bip137(rs, bitcoinMessageHash("other"), pub)).toBeNull();
  });
});
