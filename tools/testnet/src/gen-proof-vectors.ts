// Writes contracts/behest/src/testdata/proof-vectors.json: D30 destination
// proofs (EIP-191 and BIP-137) for the contract's unit tests. Deterministic.
// Usage: pnpm --filter @behest/testnet exec tsx src/gen-proof-vectors.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { p2wpkh } from "./btc.js";
import { ROOT } from "./near.js";
import { proofMessage, signBitcoinMessage } from "./proofs.js";

const C = "behest.testnet";
const OWNER = "owner.testnet";
const eth = privateKeyToAccount(`0x${"55".repeat(32)}`);
const btcKey = new Uint8Array(32).fill(0x66);
const btcAddr = p2wpkh(btcKey).address!;
const ethAddr = eth.address.toLowerCase();
const m = (account: string, chain: "Eth" | "Btc" | "Intents", d: string) => proofMessage(C, OWNER, account, chain, d);
const out = {
  eth_address: ethAddr,
  btc_address: btcAddr,
  // Amara proves her Ethereum destination; Tobi a requested one; the BTC one for Amara.
  eth_amara: await eth.signMessage({ message: m("amara.testnet", "Eth", ethAddr) }),
  eth_tobi: await eth.signMessage({ message: m("tobi.testnet", "Eth", ethAddr) }),
  btc_amara: signBitcoinMessage(m("amara.testnet", "Btc", btcAddr), btcKey),
  message_sample: m("amara.testnet", "Eth", ethAddr),
};
writeFileSync(join(ROOT, "contracts/behest/src/testdata/proof-vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log(out);
