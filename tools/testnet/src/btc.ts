// Bitcoin testnet4 helpers for live scenarios: a funder wallet (BTC_FUNDER_KEY
// in the root .env) and Esplora reads (blockstream.info by default).
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "node:crypto";

export const NET = btc.TEST_NETWORK; // tb1… (testnet4 uses the testnet prefixes)
export const ESPLORA = (process.env.BTC_ESPLORA_URL || "https://blockstream.info/testnet4/api").replace(/\/$/, "");

export function funderKey(): Uint8Array {
  const raw = (process.env.BTC_FUNDER_KEY ?? "").trim();
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error("BTC_FUNDER_KEY must be a 32-byte hex private key");
  return hex.decode(raw);
}
export const p2wpkh = (priv: Uint8Array) => btc.p2wpkh(secp256k1.getPublicKey(priv, true), NET);
export const newKey = () => new Uint8Array(randomBytes(32));

export interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean } }
export async function utxos(address: string): Promise<Utxo[]> {
  const r = await fetch(`${ESPLORA}/address/${address}/utxo`);
  if (!r.ok) throw new Error(`esplora ${r.status}`);
  return (await r.json()) as Utxo[];
}
export const balance = async (address: string) => (await utxos(address)).reduce((a, u) => a + u.value, 0);
export async function broadcast(rawHex: string): Promise<string> {
  const r = await fetch(`${ESPLORA}/tx`, { method: "POST", body: rawHex });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast failed: ${body}`);
  return body.trim();
}
export async function feeRate(): Promise<number> {
  // Esplora /fee-estimates: confirmation target (blocks) -> sat/vB
  const r = await fetch(`${ESPLORA}/fee-estimates`);
  const est = r.ok ? ((await r.json()) as Record<string, number>)["3"] : undefined;
  return Math.max(1, Math.ceil(est ?? 2));
}

/** Sends `amount` sats from a P2WPKH key to `to`, change back to the key. */
export async function send(priv: Uint8Array, to: string, amount: number, rate = 2): Promise<string> {
  const me = p2wpkh(priv);
  const coins = (await utxos(me.address!)).map((u) => ({ txid: u.txid, index: u.vout, witnessUtxo: { script: me.script, amount: BigInt(u.value) } }));
  const sel = btc.selectUTXO(coins, [{ address: to, amount: BigInt(amount) }], "default", { changeAddress: me.address!, feePerByte: BigInt(rate), bip69: false, createTx: true, network: NET });
  if (!sel?.tx) throw new Error("not enough tBTC in the funder wallet");
  sel.tx.sign(priv);
  sel.tx.finalize();
  return broadcast(sel.tx.hex);
}
