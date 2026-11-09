// "Try as…" sandbox: a set of funded testnet personas created on request.
// Their NEAR keys and the heirs' Sepolia keys live only in this browser.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const PERSONA_ROLES = ["owner", "g1", "g2", "g3", "amara", "tobi"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

export interface Persona {
  role: PersonaRole;
  accountId: string;
  secretKey: string;
  label: string;
  blurb: string;
}

export interface Sandbox {
  createdAt: number;
  personas: Record<PersonaRole, Persona>;
  /** Sepolia wallets generated for the heirs (testnet only). */
  eth: { amara: { address: Hex; key: Hex }; tobi: { address: Hex; key: Hex } };
}

export const PERSONA_INFO: Record<PersonaRole, { label: string; blurb: string }> = {
  owner: { label: "Kemi · owner", blurb: "Sets the plan, checks in, can cancel a release." },
  g1: { label: "Dayo · guardian", blurb: "Proposes a release once Kemi is unreachable." },
  g2: { label: "Funmi · guardian", blurb: "Approves or rejects the exact proposal." },
  g3: { label: "Chidi · guardian", blurb: "A third vote; quorum is 2 of 3." },
  amara: { label: "Amara · heir", blurb: "60%. Receives NEAR and Sepolia ETH." },
  tobi: { label: "Tobi · heir", blurb: "40%. Receives NEAR and Sepolia ETH." },
};

const KEY = "behest.sandbox";

export function loadSandbox(): Sandbox | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Sandbox) : null;
    // An older or partial sandbox (missing a persona or the heir wallets) is discarded.
    if (!s || !s.eth?.amara || !s.eth?.tobi || PERSONA_ROLES.some((r) => !s.personas?.[r]?.accountId)) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSandbox(s: Sandbox) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export function clearSandbox() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export function heirWallet() {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

// Plans this browser has looked at, for the home screen.
const WATCH = "behest.watching";
export function watched(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WATCH) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function watch(owner: string) {
  try {
    localStorage.setItem(WATCH, JSON.stringify([owner, ...watched().filter((o) => o !== owner)].slice(0, 20)));
  } catch {}
}
