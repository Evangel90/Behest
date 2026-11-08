// Creates the Bitcoin testnet4 funder wallet (once) and prints its address and balance.
// Usage: pnpm --filter @behest/testnet btc-funder
import { hex } from "@scure/base";
import { setEnv } from "./near.js";
import { balance, newKey, p2wpkh } from "./btc.js";

let key = (process.env.BTC_FUNDER_KEY ?? "").trim();
if (!key) {
  key = hex.encode(newKey());
  setEnv({ BTC_FUNDER_KEY: key });
  console.log("• generated BTC_FUNDER_KEY in the root .env");
}
const addr = p2wpkh(hex.decode(key)).address!;
console.log(`• funder address (testnet4): ${addr}`);
console.log(`• balance: ${await balance(addr).catch(() => "unreadable")} sats`);
