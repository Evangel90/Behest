// NEP-413 signed messages: how a NEAR account proves it controls a key
// without sending a transaction. https://github.com/near/NEPs/blob/master/neps/nep-0413.md
//
// The signed bytes are sha256( u32le(2^31 + 413) ‖ borsh({ message: string,
// nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }) ), signed
// with ed25519. The notifier then checks that the key is a full-access key
// of the account, by RPC.
import { createPublicKey, createHash, verify as edVerify } from "node:crypto";
import { baseDecode, baseEncode } from "near-api-js";

export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** The 32-byte hash a wallet signs for a NEP-413 message. */
export function payloadHash(p: Nep413Payload): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]);
  const bytes = Buffer.concat([tag, borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), cb]);
  return createHash("sha256").update(bytes).digest();
}

/** "ed25519:<base58>" → raw 32-byte key, or null for other key types. */
export function ed25519Key(publicKey: string): Buffer | null {
  const [type, data] = publicKey.includes(":") ? publicKey.split(":") : ["ed25519", publicKey];
  if (type !== "ed25519" || !data) return null;
  try {
    const raw = Buffer.from(baseDecode(data));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/** Wallets return base64 signatures (NEP-413); some return "ed25519:<base58>". */
export function decodeSignature(sig: string): Buffer | null {
  try {
    if (sig.startsWith("ed25519:")) {
      const b = Buffer.from(baseDecode(sig.slice(8)));
      return b.length === 64 ? b : null;
    }
    const b = Buffer.from(sig, "base64");
    if (b.length === 64) return b;
    const b58 = Buffer.from(baseDecode(sig));
    return b58.length === 64 ? b58 : null;
  } catch {
    return null;
  }
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** True if `signature` is `publicKey`'s ed25519 signature of the payload. */
export function verifyNep413(p: Nep413Payload, publicKey: string, signature: string): boolean {
  const raw = ed25519Key(publicKey);
  const sig = decodeSignature(signature);
  if (!raw || !sig) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
  try {
    return edVerify(null, payloadHash(p), key, sig);
  } catch {
    return false;
  }
}

export const isImplicit = (account: string) => /^[0-9a-f]{64}$/.test(account);

/** For a NEAR implicit account (64 hex chars) the account id is the key itself. */
export function implicitKey(account: string): string | null {
  return isImplicit(account) ? `ed25519:${baseEncode(Buffer.from(account, "hex"))}` : null;
}

export type KeyLookup = (account: string) => Promise<string[] | null>;

/**
 * Full-access keys of an account via JSON-RPC `view_access_key_list`
 * (null if the account doesn't exist). Results are cached briefly.
 */
export function rpcKeyLookup(rpcUrl: string, ttlMs = 60_000, fetchFn: typeof fetch = fetch): KeyLookup {
  const cache = new Map<string, { at: number; keys: string[] | null }>();
  return async (account) => {
    const hit = cache.get(account);
    if (hit && Date.now() - hit.at < ttlMs) return hit.keys;
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "notifier", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } }),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = (await res.json()) as { result?: { keys: { public_key: string; access_key: { permission: unknown } }[] }; error?: { cause?: { name?: string }; message?: string } };
    let keys: string[] | null;
    if (body.error) {
      if (body.error.cause?.name !== "UNKNOWN_ACCOUNT") throw new Error(`rpc: ${body.error.message ?? "error"}`);
      keys = null;
    } else {
      keys = (body.result?.keys ?? []).filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
    }
    cache.set(account, { at: Date.now(), keys });
    return keys;
  };
}

/** Does `publicKey` control `account`? Full-access key, or the implicit account's own key. */
export async function controls(account: string, publicKey: string, lookup: KeyLookup): Promise<boolean> {
  const keys = await lookup(account);
  // An implicit account that doesn't exist yet has no keys on chain (RPCs answer
  // either UNKNOWN_ACCOUNT or an empty list); its id is its key.
  if (!keys?.length) return implicitKey(account) === publicKey;
  return keys.includes(publicKey);
}
