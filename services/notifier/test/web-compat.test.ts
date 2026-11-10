// The web app signs notifier actions itself (apps/web/src/lib/notify.ts). This
// checks a persona session's envelope passes the notifier's real verification.
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { verifyEnvelope } from "../src/auth.js";
import { Store } from "../src/db.js";

describe("web app ↔ notifier", () => {
  it("a persona's signed request verifies, arguments intact", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const account = "kemi-test.testnet";
    const persona = { role: "owner", accountId: account, secretKey: kp.toString(), label: "Kemi", blurb: "" };
    const personas = Object.fromEntries(["owner", "g1", "g2", "g3", "amara", "tobi"].map((r) => [r, { ...persona, role: r, accountId: r === "owner" ? account : `${r}.testnet` }]));
    const mem = new Map([["behest.sandbox", JSON.stringify({ createdAt: 0, personas, eth: { amara: { address: "0x1", key: "0x1" }, tobi: { address: "0x2", key: "0x2" } } })]]);
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
    // a runtime path keeps the web app's sources out of this package's typecheck
    const webModule = new URL("../../../apps/web/src/lib/notify.ts", import.meta.url).pathname;
    const { signAction } = (await import(/* @vite-ignore */ webModule)) as { signAction: (s: unknown, summary: string, action: string, args: Record<string, unknown>) => Promise<Parameters<typeof verifyEnvelope>[0] & { message: string }> };
    const env = await signAction({ accountId: account, kind: "persona", label: "Kemi", via: "Test persona", call: async () => ({ txHash: "", sponsored: false }) }, "send notices to k@example.com", "contacts.add", { channel: "email", address: "k@example.com" });
    const a = await verifyEnvelope(env, { store: new Store(), keys: async () => [kp.getPublicKey().toString()], recipient: "behest-notifier", maxAgeMs: 60_000 }, "contacts.add");
    expect(a).toMatchObject({ account, channel: "email", address: "k@example.com" });
    expect(env.message.startsWith("Behest notifications: send notices to k@example.com\n")).toBe(true);
  });
});
