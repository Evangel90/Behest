// Test vector for the contract's NEAR vault sweep transaction (nearvault.rs):
// the same transaction encoded by near-api-js, and an Ed25519 signature over
// its sha256 by a fixed key. Prints Rust constants for tests.rs.
import { createHash } from "node:crypto";
import { KeyPair, actions, createTransaction, encodeTransaction, SignedTransaction, Signature, baseDecode } from "near-api-js";

const kp = KeyPair.fromString(`ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr`);
const pk = kp.getPublicKey();
const pkBytes = Buffer.from(pk.data);
const signer = pkBytes.toString("hex");
const blockHash = baseDecode("CgAvK69Ec8WnofJ9ES26MqqZTG545C7s4wdZTCEoydTE");
const args = Buffer.from(JSON.stringify({ owner: "owner.testnet" }));
const tx = createTransaction(signer, pk, "behest.testnet", 7n, [actions.functionCall("deposit", args, 10_000_000_000_000n, 123_456_789_000_000_000_000_000n)], blockHash);
const bytes = Buffer.from(encodeTransaction(tx));
const hash = createHash("sha256").update(bytes).digest();
const sig = Buffer.from(kp.sign(hash).signature);
const signed = Buffer.from(new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: sig }) }).encode());
console.log(`const PK: &str = "${pkBytes.toString("hex")}";`);
console.log(`const BLOCK_HASH: &str = "CgAvK69Ec8WnofJ9ES26MqqZTG545C7s4wdZTCEoydTE";`);
console.log(`const TX: &str = "${bytes.toString("hex")}";`);
console.log(`const SIG: &str = "${sig.toString("hex")}";`);
console.log(`const SIGNED_B64: &str = "${signed.toString("base64")}";`);
