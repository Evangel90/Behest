// D30 helpers shared by the destination cards (pure, unit-tested).
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

