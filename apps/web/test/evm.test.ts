import { hashMessage, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { describeAction, networkOf, parseSignedAction, planName, signedActionMessage } from "../src/lib/evm/action";

const ACTOR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

describe("signed action message (D23 wire format)", () => {
  const msg = signedActionMessage({
    contract: "behest-ekkr6.testnet",
    actor: ACTOR,
    method: "approve_release",
    args: { owner: "kemi.testnet", proposal_id: 3 },
    nonce: 7n,
    deadlineMs: 1_789_000_000_000,
    summary: "Approve release #3 of Kemi's plan",
  });

  it("is header, summary, blank line, then one JSON object", () => {
    expect(msg).toBe(
      'Behest signed action\nApprove release #3 of Kemi\'s plan\n\n{"contract":"behest-ekkr6.testnet","network":"testnet","actor":"0x71c7656ec7ab88b098defb751b7401b5f6d8976f","method":"approve_release","args":{"owner":"kemi.testnet","proposal_id":3},"nonce":"7","deadline_ms":"1789000000000"}',
    );
    expect(msg.endsWith("\n")).toBe(false);
  });

  it("keeps nonce and deadline as decimal strings, actor lowercase, and round-trips", () => {
    const { summary, body } = parseSignedAction(msg);
    expect(summary).toBe("Approve release #3 of Kemi's plan");
    expect(body).toEqual({
      contract: "behest-ekkr6.testnet",
      network: "testnet",
      actor: ACTOR.toLowerCase(),
      method: "approve_release",
      args: { owner: "kemi.testnet", proposal_id: 3 },
      nonce: "7",
      deadline_ms: "1789000000000",
    });
    // u64 beyond 2^53 survives as text
    const big = parseSignedAction(signedActionMessage({ contract: "c.testnet", actor: ACTOR, method: "check_in", args: {}, nonce: 2n ** 63n, deadlineMs: "18446744073709551615", summary: "x" }));
    expect(big.body.nonce).toBe("9223372036854775808");
    expect(big.body.deadline_ms).toBe("18446744073709551615");
  });

  it("puts the JSON after the first blank line even when the summary tries to add lines", () => {
    const m = signedActionMessage({ contract: "c.testnet", actor: ACTOR, method: "check_in", args: {}, nonce: 0, deadlineMs: 1, summary: "line one\n\nline two\r\n" });
    const [head, summary, blank] = m.split("\n");
    expect([head, summary, blank]).toEqual(["Behest signed action", "line one line two", ""]);
    expect(JSON.parse(m.slice(m.indexOf("\n\n") + 2)).method).toBe("check_in");
  });

  it("derives the network from the contract account", () => {
    expect(networkOf("behest.near")).toBe("mainnet");
    expect(networkOf("behest-ekkr6.testnet")).toBe("testnet");
    expect(JSON.parse(signedActionMessage({ contract: "behest.near", actor: ACTOR, method: "check_in", args: {}, nonce: 0, deadlineMs: 1, summary: "x" }).split("\n\n")[1]!).network).toBe("mainnet");
  });

  it("refuses an actor that isn't an address", () => {
    expect(() => signedActionMessage({ contract: "c.testnet", actor: "kemi.testnet", method: "check_in", args: {}, nonce: 0, deadlineMs: 1, summary: "x" })).toThrow();
  });

  it("is what personal_sign signs: EIP-191 over the UTF-8 bytes, recoverable to the actor", async () => {
    const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const m = signedActionMessage({ contract: "behest-ekkr6.testnet", actor: acct.address, method: "claim", args: { owner: "kemi.testnet" }, nonce: 0, deadlineMs: 1_789_000_000_000, summary: "Claim your share of Kemi's plan — ₦ ✓" });
    const sig = await acct.signMessage({ message: m });
    expect(sig).toHaveLength(132);
    expect((await recoverMessageAddress({ message: m, signature: sig })).toLowerCase()).toBe(acct.address.toLowerCase());
    // the length prefix counts bytes, not characters
    const bytes = toBytes(m);
    expect(bytes.length).toBeGreaterThan(m.length);
    expect(hashMessage(m)).toBe(hashMessage({ raw: bytes }));
  });
});

describe("summary line", () => {
  const me = ACTOR.toLowerCase();
  it("names the plan in plain words", () => {
    expect(describeAction("approve_release", { owner: "kemi.testnet", proposal_id: 3 }, me)).toBe("Approve release #3 of Kemi's plan");
    expect(describeAction("reject_release", { owner: "kemi.testnet", proposal_id: 4 }, me)).toBe("Reject release #4 of Kemi's plan");
    expect(describeAction("claim", { owner: "x7f2-kemi.demo.testnet" }, me)).toMatch(/^Claim your share of .+'s plan$/);
    expect(describeAction("propose_release", { owner: "0xAbCdEf0123456789abcdef0123456789ABCDEF01" }, me)).toBe("Propose a release of 0xabcd…ef01's plan");
    expect(describeAction("retry_transfer", { owner: "kemi.testnet", index: 0 }, me)).toBe("Retry payout #1 of Kemi's plan");
    expect(describeAction("release", { owner: "kemi.testnet", heir: "amara.testnet" }, me)).toBe("Pay out Amara's share of Kemi's plan");
  });
  it("says 'your plan' for the owner's own actions", () => {
    expect(describeAction("check_in", {}, me)).toBe("Check in on your plan");
    expect(describeAction("set_plan", { plan: {} }, me)).toBe("Save your inheritance plan");
    expect(describeAction("register_btc_vault", { owner: me.toUpperCase().replace("0X", "0x") }, me)).toBe("Set up the Bitcoin vault of your plan");
    expect(planName(undefined, me)).toBe("the plan");
  });
  it("falls back to the method name", () => {
    expect(describeAction("something_new", {}, me)).toBe("Call something_new on Behest");
  });
});
