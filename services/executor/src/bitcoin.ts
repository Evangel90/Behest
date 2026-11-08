// Bitcoin testnet side of the executor (D20): an Esplora client and the
// defence-in-depth check of a contract-signed payout before broadcast.

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { BtcPort, BtcTx, Transfer } from "./types.js";

export const NET = btc.TEST_NETWORK; // testnet4 / signet share the tb prefix

export const scriptOf = (address: string) => hex.encode(btc.OutScript.encode(btc.Address(NET).decode(address)));

/**
 * The raw tx must be exactly what the contract built: its txid, its inputs,
 * the heir (or owner) output first, and nothing but vault change after it.
 * Returns a reason when it isn't.
 */
export function checkBtcTx(raw: string, b: BtcTx, t: Pick<Transfer, "destination" | "amount">, vaultAddress: string): string | null {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
  } catch {
    return "undecodable";
  }
  if (tx.id !== b.txid) return "txid";
  if (tx.inputsLength !== b.inputs.length) return "inputs";
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (hex.encode(inp.txid!) !== b.inputs[i]!.txid.toLowerCase() || inp.index !== b.inputs[i]!.vout) return "inputs";
  }
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  const pay = outs[0];
  if (!pay || hex.encode(pay.script!) !== scriptOf(t.destination) || pay.amount !== BigInt(t.amount)) return "payout";
  const vault = scriptOf(vaultAddress);
  if (outs.length > 2 || (outs[1] && hex.encode(outs[1].script!) !== vault)) return "change";
  return null;
}

export function createBtcPort(esplora: string): BtcPort {
  const base = esplora.replace(/\/$/, "");
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`esplora ${path}: ${r.status}`);
    return r;
  };
  return {
    async broadcast(raw) {
      const r = await fetch(`${base}/tx`, { method: "POST", body: raw });
      const body = await r.text();
      if (!r.ok) throw new Error(body);
      return body.trim();
    },
    async status(txid) {
      const r = await get(`/tx/${txid}/status`);
      if (!r) return null;
      const s = (await r.json()) as { confirmed: boolean; block_height?: number };
      return { confirmed: s.confirmed, height: s.block_height ?? null };
    },
    async tipHeight() {
      const r = await get("/blocks/tip/height");
      return Number(await r!.text());
    },
    async outspend(txid, vout) {
      const r = await get(`/tx/${txid}/outspend/${vout}`);
      if (!r) return null;
      const s = (await r.json()) as { spent: boolean; txid?: string };
      return s.spent ? (s.txid ?? null) : "unspent";
    },
  };
}
