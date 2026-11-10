import { describe, expect, it } from "vitest";
import { baseDecode, baseEncode } from "near-api-js";
import { AuthError, actionMessage, verifyEnvelope } from "../src/auth.js";
import { Store } from "../src/db.js";
import { controls, decodeSignature, implicitKey, payloadHash, rpcKeyLookup, verifyNep413 } from "../src/nep413.js";
import { envelope, newSigner, RECIPIENT } from "./helpers.js";

// Fixed vector: ed25519 seed 0x07×32 signing NEP-413 {message "hello", nonce 0x09×32,
// recipient "behest-notifier"} with near-api-js's KeyPairSigner.signNep413Message.
const VEC = {
  publicKey: "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
  signature: "qPkU3Lsk4xxIbWc9e1YNuWRfpGuNOH95KfjZ1PbDJSfPF7C9X8oZ1szk9Y1Cp2l3U78hGPhR3aApi5gs6x2bAg==",
  payload: { message: "hello", nonce: Buffer.alloc(32, 9), recipient: "behest-notifier" },
};

describe("NEP-413 verification", () => {
  it("verifies a signature produced by near-api-js", () => {
    expect(verifyNep413(VEC.payload, VEC.publicKey, VEC.signature)).toBe(true);
  });

  it("rejects any change to message, nonce, recipient, key or callback", () => {
    expect(verifyNep413({ ...VEC.payload, message: "hellO" }, VEC.publicKey, VEC.signature)).toBe(false);
    expect(verifyNep413({ ...VEC.payload, nonce: Buffer.alloc(32, 8) }, VEC.publicKey, VEC.signature)).toBe(false);
    expect(verifyNep413({ ...VEC.payload, recipient: "evil" }, VEC.publicKey, VEC.signature)).toBe(false);
    expect(verifyNep413({ ...VEC.payload, callbackUrl: "https://x" }, VEC.publicKey, VEC.signature)).toBe(false);
    expect(verifyNep413(VEC.payload, newSigner().publicKey, VEC.signature)).toBe(false);
    expect(verifyNep413(VEC.payload, "secp256k1:abc", VEC.signature)).toBe(false);
    expect(verifyNep413(VEC.payload, VEC.publicKey, "not a signature")).toBe(false);
  });

  it("accepts base58 signatures some wallets return", () => {
    const raw = Buffer.from(VEC.signature, "base64");
    expect(decodeSignature(`ed25519:${baseEncode(raw)}`)?.equals(raw)).toBe(true);
    expect(verifyNep413(VEC.payload, VEC.publicKey, `ed25519:${baseEncode(raw)}`)).toBe(true);
  });

  it("round-trips random keys and callback URLs", async () => {
    const { signer, publicKey } = newSigner();
    const p = { message: "x".repeat(300), nonce: Buffer.alloc(32, 1), recipient: "r", callbackUrl: "https://app/cb" };
    const sig = await signer.signNep413Message("a.testnet", p);
    expect(verifyNep413(p, publicKey, Buffer.from(sig.signature).toString("base64"))).toBe(true);
    expect(() => payloadHash({ ...p, nonce: Buffer.alloc(31) })).toThrow();
  });

  it("only counts full-access keys, or an implicit account's own key", async () => {
    const lookup = async (a: string) => (a === "kemi.testnet" ? [VEC.publicKey] : null);
    expect(await controls("kemi.testnet", VEC.publicKey, lookup)).toBe(true);
    expect(await controls("kemi.testnet", newSigner().publicKey, lookup)).toBe(false);
    const hex = Buffer.from(require58(VEC.publicKey)).toString("hex");
    expect(implicitKey(hex)).toBe(VEC.publicKey);
    expect(await controls(hex, VEC.publicKey, lookup)).toBe(true);
    expect(await controls("ghost.testnet", VEC.publicKey, lookup)).toBe(false);
    expect(await controls(hex, VEC.publicKey, async () => [])).toBe(true);
    expect(await controls("ghost.testnet", VEC.publicKey, async () => [])).toBe(false);
  });

  it("reads keys over RPC and drops function-call keys", async () => {
    const fake = (async (_url: string, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as { params: { account_id: string } };
      const body =
        params.account_id === "none.testnet"
          ? { error: { cause: { name: "UNKNOWN_ACCOUNT" }, message: "unknown" } }
          : { result: { keys: [{ public_key: "ed25519:full", access_key: { permission: "FullAccess" } }, { public_key: "ed25519:fc", access_key: { permission: { FunctionCall: {} } } }] } };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const lookup = rpcKeyLookup("http://rpc", 60_000, fake);
    expect(await lookup("kemi.testnet")).toEqual(["ed25519:full"]);
    expect(await lookup("none.testnet")).toBeNull();
  });
});

const require58 = (k: string) => baseDecode(k.split(":")[1]!);

describe("signed requests", () => {
  const setup = () => {
    const { signer, publicKey } = newSigner();
    const store = new Store();
    const deps = { store, keys: async (a: string) => (a === "kemi.testnet" ? [publicKey] : []), recipient: RECIPIENT, maxAgeMs: 5 * 60_000 };
    return { signer, store, deps };
  };

  it("returns the signed action and its arguments", async () => {
    const { signer, deps } = setup();
    const env = await envelope(signer, "kemi.testnet", "contacts.add", { channel: "email", address: "k@example.com" });
    const a = await verifyEnvelope(env, deps, "contacts.add");
    expect(a).toMatchObject({ action: "contacts.add", account: "kemi.testnet", channel: "email", address: "k@example.com" });
    expect(env.message.split("\n")[0]).toBe("Behest notifications: contacts.add");
  });

  it("refuses replays, stale or future timestamps, other recipients, other accounts and foreign keys", async () => {
    const { signer, deps } = setup();
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: AuthError) => e.code);
    const env = await envelope(signer, "kemi.testnet", "session");
    expect(await code(verifyEnvelope(env, deps))).toBe("ok");
    expect(await code(verifyEnvelope(env, deps))).toBe("REPLAY");
    expect(await code(verifyEnvelope(await envelope(signer, "kemi.testnet", "session", {}, { ts: Date.now() - 6 * 60_000 }), deps))).toBe("STALE");
    expect(await code(verifyEnvelope(await envelope(signer, "kemi.testnet", "session", {}, { ts: Date.now() + 6 * 60_000 }), deps))).toBe("STALE");
    expect(await code(verifyEnvelope(await envelope(signer, "kemi.testnet", "session", {}, { recipient: "other-app" }), deps))).toBe("WRONG_RECIPIENT");
    expect(await code(verifyEnvelope(await envelope(signer, "dayo.testnet", "session"), deps))).toBe("NOT_ACCOUNT_KEY");
    expect(await code(verifyEnvelope(await envelope(signer, "kemi.testnet", "session"), deps, "contacts.add"))).toBe("WRONG_ACTION");
    // the signed JSON names one account, the envelope claims another
    const forged = { ...(await envelope(signer, "kemi.testnet", "session")), accountId: "dayo.testnet" };
    expect(await code(verifyEnvelope(forged, deps))).toBe("ACCOUNT_MISMATCH");
    // arguments swapped after signing break the signature
    const swapped = await envelope(signer, "kemi.testnet", "contacts.add", { address: "k@example.com" });
    swapped.message = swapped.message.replace("k@example.com", "evil@example.com");
    expect(await code(verifyEnvelope(swapped, deps))).toBe("BAD_SIGNATURE");
    expect(await code(verifyEnvelope({}, deps))).toBe("UNSIGNED");
  });

  it("an unreachable RPC is a retryable error, not a rejection", async () => {
    const { signer, deps } = setup();
    const env = await envelope(signer, "kemi.testnet", "session");
    const err = await verifyEnvelope(env, { ...deps, keys: async () => Promise.reject(new Error("down")) }).catch((e: AuthError) => e);
    expect((err as AuthError).code).toBe("RPC_UNAVAILABLE");
    // the nonce wasn't spent, so the same signature works once the RPC is back
    expect((await verifyEnvelope(env, deps)).action).toBe("session");
  });

  it("builds readable messages", () => {
    expect(() => actionMessage("bad {", { action: "x", account: "a", ts: 1 })).toThrow();
  });
});
