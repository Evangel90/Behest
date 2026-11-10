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
import type { Store } from "./db.js";
import { controls, verifyNep413, type KeyLookup } from "./nep413.js";

export interface SignedEnvelope {
  accountId: string;
  publicKey: string;
  signature: string;
  /** 32 bytes, base64. */
  nonce: string;
  message: string;
  recipient: string;
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

/** Verifies a signed envelope and returns its action. Consumes the nonce. */
export async function verifyEnvelope(env: unknown, deps: AuthDeps, expectAction?: string | string[]): Promise<SignedAction> {
  const e = env as Partial<SignedEnvelope> | null;
  if (!e || typeof e !== "object") throw new AuthError("UNSIGNED", "a signed request is required");
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
