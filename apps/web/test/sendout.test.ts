// Moving a heir's bitcoin out of the account kept for their email: coin
// selection, the externally-signed transaction, and the wizard rules for
// people named by email.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { segwitAddress } from "../src/lib/evm/email";
import { SendError, buildBtc, checkBtcAddress, derSignature, planBtc } from "../src/lib/sendout";
import { accountOf, guardianErrors, heirErrors, intentsDeliveries, looksLikeEmail, unresolvedEmails } from "../src/lib/wizard";

const PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = secp256k1.getPublicKey(PRIV, true);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const me = btc.p2wpkh(PUB, btc.TEST_NETWORK);
/** Stands in for the sign-in service: signs a 32-byte digest and returns r || s. */
const wallet = (calls: Uint8Array[] = []) => ({
  btc: me.address!,
  btcPublicKey: hex(PUB),
  signBtc: async (digest: Uint8Array) => {
    calls.push(digest);
    return secp256k1.sign(digest, PRIV, { prehash: false, lowS: false });
  },
});
const DEST = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const coin = (n: number, value: number) => ({ txid: n.toString(16).padStart(64, "0"), vout: n, value: String(value) });

describe("Bitcoin addresses", () => {
  it("derives the same SegWit address the wallet service reports, on either network", () => {
    // A real key/address pair from Privy.
    const pk = "02907a09c9d2cdf02da9793c13be3930a90f86ec368b30bb9b0b510047043f331e";
    expect(segwitAddress(pk, true)).toBe("bc1q6w2tsrzr2p76d26rndtw3s8k2pcwc8mchtgv63");
    expect(segwitAddress(hex(PUB), false)).toBe(me.address);
  });

  it("accepts testnet SegWit and Taproot addresses and explains the rest", () => {
    expect(checkBtcAddress(DEST)).toBeNull();
    expect(checkBtcAddress("tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c")).toBeNull();
    expect(checkBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toMatch(/mainnet address/);
    expect(checkBtcAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toMatch(/Older address formats/);
    expect(checkBtcAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy")).toMatch(/doesn't look like/); // bad checksum
    expect(checkBtcAddress("hello")).toMatch(/doesn't look like/);
  });
});

describe("choosing coins", () => {
  it("empties the address into one output when asked for everything", () => {
    const p = planBtc([coin(1, 30_000), coin(2, 20_000)], null, 2);
    expect(p.inputs).toHaveLength(2);
    expect(p.change).toBe(0n);
    expect(p.amount + p.fee).toBe(50_000n);
    expect(p.fee).toBe(BigInt(Math.ceil((11 + 68 * 2 + 43) * 2)));
  });

  it("uses the fewest coins, returns change, and folds dust-sized change into the fee", () => {
    const p = planBtc([coin(1, 5_000), coin(2, 60_000), coin(3, 40_000)], 30_000n, 2);
    expect(p.inputs.map((i) => i.value)).toEqual([60_000n]);
    expect(p.amount).toBe(30_000n);
    expect(p.fee).toBe(BigInt((11 + 68 + 43 * 2) * 2));
    expect(p.change).toBe(60_000n - 30_000n - p.fee);
    // 60,000 in, 59,700 out: the 300 left can't be a change output, so it is all fee
    const tight = planBtc([coin(2, 60_000)], 59_700n, 1);
    expect(tight).toMatchObject({ change: 0n, fee: 300n, amount: 59_700n });
    const two = planBtc([coin(1, 20_000), coin(2, 25_000)], 40_000n, 1);
    expect(two.inputs).toHaveLength(2);
  });

  it("refuses what the coins can't cover, dust, and an empty address", () => {
    expect(() => planBtc([coin(1, 10_000)], 10_000n, 2)).toThrow(/more than this address holds/);
    expect(() => planBtc([coin(1, 10_000)], 100n, 2)).toThrow(/smallest amount/);
    expect(() => planBtc([coin(1, 600)], null, 5)).toThrow(/too little/);
    expect(() => planBtc([], null, 2)).toThrow(SendError);
  });
});

describe("a transaction signed outside the browser", () => {
  it("puts r||s into DER with a low S", () => {
    const digest = Uint8Array.from({ length: 32 }, () => 7);
    const rs = secp256k1.sign(digest, PRIV, { prehash: false, lowS: false });
    const der = derSignature(rs);
    expect(secp256k1.verify(der, digest, PUB, { prehash: false, format: "der" })).toBe(true);
    // the same signature with S flipped high encodes to the same low-S form
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${hex(rs.slice(32))}`);
    const flipped = Uint8Array.from([...rs.slice(0, 32), ...Uint8Array.from((n - s).toString(16).padStart(64, "0").match(/../g)!.map((b) => parseInt(b, 16)))]);
    expect(hex(derSignature(flipped))).toBe(hex(der));
    expect(() => derSignature(new Uint8Array(63))).toThrow(SendError);
    expect(() => derSignature(new Uint8Array(64))).toThrow(/invalid signature/);
  });

  it("is byte-for-byte what a wallet holding the key would have produced", async () => {
    const utxos = [coin(1, 60_000), coin(2, 40_000)];
    const plan = planBtc(utxos, 75_000n, 3);
    const digests: Uint8Array[] = [];
    const ours = await buildBtc(wallet(digests), DEST, plan);
    expect(digests).toHaveLength(2);

    const ref = new btc.Transaction();
    for (const i of plan.inputs) ref.addInput({ txid: i.txid, index: i.vout, witnessUtxo: { script: me.script, amount: i.value }, sequence: 0xfffffffd });
    ref.addOutputAddress(DEST, plan.amount, btc.TEST_NETWORK);
    ref.addOutputAddress(me.address!, plan.change, btc.TEST_NETWORK);
    ref.sign(PRIV);
    ref.finalize();
    // Same unsigned transaction (same id) and, with deterministic signatures, the same witness.
    expect(ours.txid).toBe(ref.id);
    expect(ours.hex).toBe(ref.hex);
    expect(ref.fee).toBe(plan.fee);
  });

  it("refuses a wrong address, a key that isn't this address's, and a bad signature", async () => {
    const plan = planBtc([coin(1, 60_000)], null, 2);
    await expect(buildBtc(wallet(), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", plan)).rejects.toThrow(/mainnet address/);
    await expect(buildBtc({ ...wallet(), btc: DEST }, DEST, plan)).rejects.toThrow(/doesn't match its address/);
    const other = Uint8Array.from({ length: 32 }, () => 9);
    await expect(buildBtc({ ...wallet(), signBtc: async (d) => secp256k1.sign(d, other, { prehash: false }) }, DEST, plan)).rejects.toThrow(/doesn't match this account's Bitcoin key/);
  });
});

describe("people named by email in the wizard", () => {
  const owner = "kemi.testnet";
  const emails = { "amara@example.com": { account: "0x" + "a".repeat(40), near: "b".repeat(64), btc: "tb1qx" }, "me@example.com": { account: owner, near: "", btc: "" } };

  it("tells emails from accounts and knows which still need an account", () => {
    expect(looksLikeEmail(" Amara@Example.com ")).toBe(true);
    expect(looksLikeEmail("amara.testnet")).toBe(false);
    expect(looksLikeEmail("a@b")).toBe(false);
    expect(accountOf("Amara@Example.com", emails)).toBe("0x" + "a".repeat(40));
    expect(accountOf("new@example.com", emails)).toBe("");
    expect(accountOf(" Dayo.testnet ")).toBe("dayo.testnet");
    expect(unresolvedEmails(["amara@example.com", "New@example.com", "new@example.com", "dayo.testnet", ""], emails)).toEqual(["new@example.com"]);
  });

  it("accepts an email for a guardian, and catches the owner's own address and repeats once resolved", () => {
    expect(guardianErrors(["dayo@example.com", "funmi.testnet"], "2", owner)).toEqual({});
    expect(guardianErrors(["not an email@", "x"], "1", owner)["guardian.0"]).toMatch(/email address/);
    expect(guardianErrors(["me@example.com"], "1", owner, emails)["guardian.0"]).toBe("You can't guard your own plan.");
    expect(guardianErrors(["amara@example.com", "0x" + "a".repeat(40)], "1", owner, emails)["guardian.1"]).toBe("Already listed.");
    expect(guardianErrors(["dayo.testnet"], "1", owner, {}, { "dayo.testnet": "nope" })["guardian.0.email"]).toMatch(/email address/);
    expect(guardianErrors(["dayo.testnet"], "1", owner, {}, { "dayo.testnet": "dayo@example.com" })).toEqual({});
  });

  it("accepts an email for a heir and still stops someone being heir and guardian", () => {
    const heir = (account: string, o = {}) => ({ account, pct: "100", near: "", eth: "", ...o });
    expect(heirErrors([heir("amara@example.com")], owner, ["dayo.testnet"], emails)).toEqual({});
    expect(heirErrors([heir("amara@example.com")], owner, ["0x" + "a".repeat(40)], emails)["heir.0.account"]).toMatch(/both an heir and a guardian/);
    expect(heirErrors([heir("amara@example.com")], owner, ["Amara@example.com"])["heir.0.account"]).toMatch(/both an heir and a guardian/);
    expect(heirErrors([heir("me@example.com")], owner, [], emails)["heir.0.account"]).toBe("You can't be your own heir.");
    expect(heirErrors([heir("amara.testnet", { noticeEmail: "x" })], owner, [])["heir.0.email"]).toMatch(/email address/);
    expect(heirErrors([heir("")], owner, [])["heir.0.account"]).toMatch(/email address, or a NEAR account/);
    // NEAR Intents delivery is for people with their own NEAR account
    expect(intentsDeliveries([heir("amara@example.com", { intents: true }), heir("tobi.testnet", { intents: true })])).toEqual([{ account_id: "tobi.testnet", enabled: true, intents_account: null }]);
  });
});
