// Signed requests. Every change to an account's contacts carries a NEP-413
// message signed by one of that account's full-access keys. The message is a
// readable first line followed by JSON naming the action, the account, its
// arguments and when it was issued:
//
//   Behest notifications: add email a@b.c
//   {"app":"behest-notifier","v":1,"action":"contacts.add","account":"kemi.testnet","ts":1762790000000,"channel":"email","address":"a@b.c"}
//
// Replay protection: the NEP-413 recipient must be this notifier, `ts` must
// be within a few minutes of now, and each 32-byte nonce is accepted once.
// The arguments come only from the signed JSON, never from the request.
//
// EVM wallets (D23) sign the same text with `personal_sign` (EIP-191) instead:
// {scheme: "eip191", accountId: "0x…", message, signature}. The recovered
// address must be the account (its eth-implicit NEAR id); the same ±window
// applies, and the message itself is single-use (its hash is the nonce).
import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";
import type { Store } from "./db.js";
import { controls, verifyNep413, type KeyLookup } from "./nep413.js";

export interface SignedEnvelope {
  scheme?: "nep413";
  accountId: string;
  publicKey: string;
  signature: string;
  /** 32 bytes, base64. */
  nonce: string;
  message: string;
  recipient: string;
}

/** D23: an EVM wallet's `personal_sign` of the action message. */
export interface Eip191Envelope {
  scheme: "eip191";
  /** `0x` + 40 lowercase hex. */
  accountId: string;
  message: string;
  /** 65-byte `0x` r‖s‖v. */
  signature: string;
}

export interface SignedAction {
  app: "behest-notifier";
  v: 1;
  action: string;
  account: string;
  ts: number;
  [k: string]: unknown;
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The text a client signs for an action (shared with the web app). */
export function actionMessage(summary: string, a: Omit<SignedAction, "app" | "v">): string {
  if (summary.includes("{") || summary.includes("\n")) throw new Error("summary must be one line without braces");
  return `Behest notifications: ${summary}\n${JSON.stringify({ app: "behest-notifier", v: 1, ...a })}`;
}

export function parseAction(message: string): SignedAction {
  const i = message.indexOf("{");
  if (i < 0) throw new AuthError("BAD_MESSAGE", "signed message has no JSON body");
  let a: SignedAction;
  try {
    a = JSON.parse(message.slice(i)) as SignedAction;
  } catch {
    throw new AuthError("BAD_MESSAGE", "signed message JSON is invalid");
  }
  if (a.app !== "behest-notifier" || a.v !== 1 || typeof a.action !== "string" || typeof a.account !== "string" || typeof a.ts !== "number") {
    throw new AuthError("BAD_MESSAGE", "signed message is not a Behest notifier action");
  }
  return a;
}

export interface AuthDeps {
  store: Store;
  keys: KeyLookup;
  recipient: string;
  maxAgeMs: number;
  now?: () => number;
}

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** 65 bytes, v in 27/28/0/1, nonzero r and low s: one encoding per signature. */
export function canonicalEvmSignature(sig: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  return r > 0n && s > 0n && s <= HALF_N && [0, 1, 27, 28].includes(parseInt(sig.slice(130), 16));
}

function checkAction(message: string, accountId: string, deps: AuthDeps, expectAction?: string | string[]): SignedAction {
  if (message.length > 4096) throw new AuthError("BAD_MESSAGE", "signed message too long");
  const a = parseAction(message);
  if (a.account !== accountId) throw new AuthError("ACCOUNT_MISMATCH", "the message names a different account");
  if (expectAction && !(Array.isArray(expectAction) ? expectAction : [expectAction]).includes(a.action)) throw new AuthError("WRONG_ACTION", `expected ${expectAction}`);
  const now = deps.now?.() ?? Date.now();
  if (Math.abs(now - a.ts) > deps.maxAgeMs) throw new AuthError("STALE", "signed request expired; sign again");
  return a;
}

async function verifyEip191(e: Partial<Eip191Envelope>, deps: AuthDeps, expectAction?: string | string[]): Promise<SignedAction> {
  for (const f of ["accountId", "message", "signature"] as const) {
    if (typeof e[f] !== "string" || !e[f]) throw new AuthError("UNSIGNED", `signed request is missing ${f}`);
  }
  if (!/^0x[0-9a-f]{40}$/.test(e.accountId!)) throw new AuthError("ACCOUNT_MISMATCH", "an EVM account is 0x + 40 lowercase hex");
  const a = checkAction(e.message!, e.accountId!, deps, expectAction);
  if (!canonicalEvmSignature(e.signature!)) throw new AuthError("BAD_SIGNATURE", "signature must be 65 bytes with a low s");
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: e.message!, signature: e.signature! as `0x${string}` })).toLowerCase();
  } catch {
    throw new AuthError("BAD_SIGNATURE", "signature does not verify");
  }
  if (signer !== e.accountId) throw new AuthError("BAD_SIGNATURE", "signature is not this account's");
  const now = deps.now?.() ?? Date.now();
  const nonce = `eip191:${createHash("sha256").update(e.message!).digest("base64")}`;
  if (!deps.store.useNonce(nonce, e.accountId!, now + deps.maxAgeMs * 2)) throw new AuthError("REPLAY", "this signed request was already used");
  return a;
}

/** Verifies a signed envelope (NEP-413, or EIP-191 for EVM wallets) and returns its action. Consumes the nonce. */
export async function verifyEnvelope(env: unknown, deps: AuthDeps, expectAction?: string | string[]): Promise<SignedAction> {
  const e = env as Partial<SignedEnvelope> | null;
  if (!e || typeof e !== "object") throw new AuthError("UNSIGNED", "a signed request is required");
  const scheme = (e as { scheme?: unknown }).scheme;
  if (scheme === "eip191") return verifyEip191(e as Partial<Eip191Envelope>, deps, expectAction);
  if (scheme !== undefined && scheme !== "nep413") throw new AuthError("UNSIGNED", "unknown signature scheme");
  for (const f of ["accountId", "publicKey", "signature", "nonce", "message", "recipient"] as const) {
    if (typeof e[f] !== "string" || !e[f]) throw new AuthError("UNSIGNED", `signed request is missing ${f}`);
  }
  if (e.message!.length > 4096) throw new AuthError("BAD_MESSAGE", "signed message too long");
  if (e.recipient !== deps.recipient) throw new AuthError("WRONG_RECIPIENT", `signed for "${e.recipient}", not this notifier ("${deps.recipient}")`);
  const nonce = Buffer.from(e.nonce!, "base64");
  if (nonce.length !== 32) throw new AuthError("BAD_NONCE", "nonce must be 32 bytes");
  const a = parseAction(e.message!);
  if (a.account !== e.accountId) throw new AuthError("ACCOUNT_MISMATCH", "the message names a different account");
  if (expectAction && !(Array.isArray(expectAction) ? expectAction : [expectAction]).includes(a.action)) throw new AuthError("WRONG_ACTION", `expected ${expectAction}`);
  const now = deps.now?.() ?? Date.now();
  if (Math.abs(now - a.ts) > deps.maxAgeMs) throw new AuthError("STALE", "signed request expired; sign again");
  if (!verifyNep413({ message: e.message!, nonce, recipient: e.recipient! }, e.publicKey!, e.signature!)) throw new AuthError("BAD_SIGNATURE", "signature does not verify");
  let ok: boolean;
  try {
    ok = await controls(e.accountId!, e.publicKey!, deps.keys);
  } catch {
    throw new AuthError("RPC_UNAVAILABLE", "couldn't read the account's keys; try again");
  }
  if (!ok) throw new AuthError("NOT_ACCOUNT_KEY", "the key isn't a full-access key of this account");
  if (!deps.store.useNonce(nonce.toString("base64"), e.accountId!, now + deps.maxAgeMs * 2)) throw new AuthError("REPLAY", "this signed request was already used");
  return a;
}
