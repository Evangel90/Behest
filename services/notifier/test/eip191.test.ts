import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AuthError, actionMessage, canonicalEvmSignature, verifyEnvelope } from "../src/auth.js";
import { Store } from "../src/db.js";
import { RECIPIENT } from "./helpers.js";

// D23: EVM wallets sign the notifier's action text with personal_sign.
const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const account = wallet.address.toLowerCase();
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function setup() {
  const store = new Store();
  // An EVM account never needs a key lookup: the address is the account.
  const deps = { store, keys: async () => { throw new Error("no RPC for EVM accounts"); }, recipient: RECIPIENT, maxAgeMs: 5 * 60_000 };
  return { store, deps };
}

async function eip191(action: string, o: { account?: string; ts?: number; key?: typeof wallet; args?: Record<string, unknown> } = {}) {
  const message = actionMessage(action, { action, account: o.account ?? account, ts: o.ts ?? Date.now(), ...(o.args ?? {}) });
  return { scheme: "eip191" as const, accountId: o.account ?? account, message, signature: await (o.key ?? wallet).signMessage({ message }) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AuthError ? e.code : `unexpected ${String(e)}`;
  }
}

describe("EIP-191 envelopes", () => {
  it("accepts a wallet's personal_sign of the action and returns its arguments", async () => {
    const { deps } = setup();
    const a = await verifyEnvelope(await eip191("contacts.add", { args: { channel: "email", address: "a@b.c" } }), deps, "contacts.add");
    expect(a).toMatchObject({ account, action: "contacts.add", channel: "email", address: "a@b.c" });
  });

  it("is single use and time-limited", async () => {
    const { deps } = setup();
    const env = await eip191("session");
    expect(await code(verifyEnvelope(env, deps))).toBe("ok");
    expect(await code(verifyEnvelope(env, deps))).toBe("REPLAY");
    expect(await code(verifyEnvelope(await eip191("session", { ts: Date.now() - 6 * 60_000 }), deps))).toBe("STALE");
  });

  it("requires the signer to be the account", async () => {
    const { deps } = setup();
    expect(await code(verifyEnvelope(await eip191("session", { key: other }), deps))).toBe("BAD_SIGNATURE");
    const env = await eip191("session");
    expect(await code(verifyEnvelope({ ...env, accountId: other.address.toLowerCase() }, deps))).toBe("ACCOUNT_MISMATCH");
    expect(await code(verifyEnvelope({ ...env, accountId: wallet.address }, deps))).toBe("ACCOUNT_MISMATCH"); // checksummed, not the account id
    expect(await code(verifyEnvelope({ ...env, message: env.message.replace("session", "session ") }, deps))).toBe("BAD_SIGNATURE");
    expect(await code(verifyEnvelope(await eip191("session"), deps, "contacts.add"))).toBe("WRONG_ACTION");
  });

  it("refuses malleable and malformed signatures", async () => {
    const { deps } = setup();
    const env = await eip191("session");
    const s = BigInt(`0x${env.signature.slice(66, 130)}`);
    const v = parseInt(env.signature.slice(130), 16);
    const high = `${env.signature.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    expect(canonicalEvmSignature(env.signature)).toBe(true);
    expect(canonicalEvmSignature(high)).toBe(false);
    expect(await code(verifyEnvelope({ ...env, signature: high }, deps))).toBe("BAD_SIGNATURE");
    expect(await code(verifyEnvelope({ ...env, signature: env.signature.slice(0, -2) }, deps))).toBe("BAD_SIGNATURE");
    expect(await code(verifyEnvelope({ ...env, signature: "" }, deps))).toBe("UNSIGNED");
    expect(await code(verifyEnvelope({ ...env, scheme: "rsa" }, deps))).toBe("UNSIGNED");
    // The original still works afterwards: refusals don't burn the message.
    expect(await code(verifyEnvelope(env, deps))).toBe("ok");
  });
});
