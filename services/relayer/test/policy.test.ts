import { DelegateAction, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas, type Action } from "near-api-js";
import { describe, expect, it } from "vitest";
import { Limiter, PolicyError, check, decode, holdsRole } from "../src/policy.js";

const C = "behest.testnet";
const kp = KeyPair.fromRandom("ed25519");

async function delegate(opts: { sender?: string; receiver?: string; acts?: Action[] } = {}) {
  const da = new DelegateAction({
    senderId: opts.sender ?? "amara.testnet",
    receiverId: opts.receiver ?? C,
    actions: opts.acts ?? [actions.functionCall("claim", { owner: "kemi.testnet" }, teraToGas(300), 0n)],
    nonce: 1n,
    maxBlockHeight: 1000n,
    publicKey: kp.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(kp).signDelegateAction(da);
  return encodeSignedDelegate(signedDelegate);
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof PolicyError ? e.code : `unexpected ${String(e)}`;
  }
  return undefined;
}

const plan = {
  plan: {
    owner: "kemi.testnet",
    policy: { guardians: ["dayo.testnet", "funmi.testnet"], heirs: [{ account_id: "amara.testnet" }] },
  },
};

describe("check", () => {
  it("accepts a heir's claim and extracts the intent", async () => {
    const intent = check(decode(await delegate()), C);
    expect(intent).toMatchObject({ sender: "amara.testnet", method: "claim", owner: "kemi.testnet", role: "heir" });
  });

  it("sponsors owner configuration with no deposit (D24)", async () => {
    const intent = check(decode(await delegate({ sender: "kemi.testnet", acts: [actions.functionCall("set_plan", { plan: {} }, teraToGas(30), 0n)] })), C);
    expect(intent).toMatchObject({ owner: "kemi.testnet", role: "self", method: "set_plan" });
    expect(holdsRole(null, intent)).toBe(true); // a first plan has no plan yet
    const rules = check(decode(await delegate({ sender: "kemi.testnet", acts: [actions.functionCall("set_release_rules", { rules: null }, teraToGas(30), 0n)] })), C);
    expect(rules).toMatchObject({ owner: "kemi.testnet", role: "owner" });
    expect(holdsRole(plan, rules)).toBe(true);
    expect(holdsRole(plan, { ...rules, sender: "amara.testnet" })).toBe(false);
  });

  it("uses the sender as the owner for owner methods", async () => {
    const intent = check(decode(await delegate({ sender: "kemi.testnet", acts: [actions.functionCall("check_in", {}, teraToGas(30), 0n)] })), C);
    expect(intent).toMatchObject({ owner: "kemi.testnet", role: "owner_or_delegate" });
  });

  it("sponsors a check-in delegate's check-in for the plan it names (D26)", async () => {
    const intent = check(decode(await delegate({ sender: "kemi.testnet", acts: [actions.functionCall("check_in", { owner: "family.sputnikv2.testnet" }, teraToGas(30), 0n)] })), C);
    expect(intent).toMatchObject({ owner: "family.sputnikv2.testnet", role: "owner_or_delegate" });
    const dao = { plan: { owner: "family.sputnikv2.testnet", policy: { guardians: [], heirs: [] } }, checkin_delegates: ["kemi.testnet"] };
    expect(holdsRole(dao, intent)).toBe(true);
    expect(holdsRole({ ...dao, checkin_delegates: [] }, intent)).toBe(false);
    expect(holdsRole(dao, { ...intent, sender: "stranger.testnet" })).toBe(false);
    const own = check(decode(await delegate({ sender: "kemi.testnet", acts: [actions.functionCall("set_checkin_delegates", { delegates: ["a.testnet"] }, teraToGas(30), 0n)] })), C);
    expect(own).toMatchObject({ owner: "kemi.testnet", role: "owner" });
  });

  it.each([
    ["another contract", { receiver: "evil.testnet" }, "WRONG_RECEIVER"],
    ["a payable method", { acts: [actions.functionCall("deposit", { owner: "kemi.testnet" }, teraToGas(30), 0n)] }, "METHOD_NOT_SPONSORED"],
    ["owner withdrawals (EVM path only)", { acts: [actions.functionCall("withdraw", { amount: "1" }, teraToGas(30), 0n)] }, "METHOD_NOT_SPONSORED"],
    ["a plan with a deposit", { acts: [actions.functionCall("set_plan", { plan: {} }, teraToGas(30), 1n)] }, "DEPOSIT"],
    ["admin calls", { acts: [actions.functionCall("set_paused", { paused: true }, teraToGas(30), 0n)] }, "METHOD_NOT_SPONSORED"],
    ["an attached deposit", { acts: [actions.functionCall("claim", { owner: "kemi.testnet" }, teraToGas(30), 1n)] }, "DEPOSIT"],
    ["more than 300 Tgas", { acts: [actions.functionCall("claim", { owner: "kemi.testnet" }, teraToGas(301), 0n)] }, "GAS"],
    ["a NEAR transfer", { acts: [actions.transfer(1n)] }, "NOT_FUNCTION_CALL"],
    ["several actions", { acts: [actions.functionCall("claim", { owner: "kemi.testnet" }, teraToGas(30), 0n), actions.functionCall("claim", { owner: "kemi.testnet" }, teraToGas(30), 0n)] }, "ONE_ACTION"],
    ["non-JSON args", { acts: [actions.functionCall("claim", new Uint8Array([1, 2, 3]), teraToGas(30), 0n)] }, "BAD_ARGS"],
  ])("rejects %s", async (_name, opts, want) => {
    const bytes = await delegate(opts as never);
    expect(code(() => check(decode(bytes), C))).toBe(want);
  });

  it("rejects a corrupted signature", async () => {
    const bytes = await delegate();
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 0xff; // last byte belongs to the 64-byte ed25519 signature
    expect(code(() => check(decode(bytes), C))).toBe("BAD_SIGNATURE");
  });

  it("rejects tampered bytes", async () => {
    const bytes = await delegate();
    const i = Buffer.from(bytes).indexOf(Buffer.from("kemi"));
    bytes[i] = 0x78; // "k" → "x": owner arg changed after signing
    expect(code(() => check(decode(bytes), C))).toBe("BAD_SIGNATURE");
  });

  it("rejects garbage", () => {
    expect(code(() => decode(new Uint8Array([1, 2, 3])))).toBe("BAD_ENCODING");
  });
});

describe("holdsRole", () => {
  const intent = (sender: string, role: "heir" | "guardian" | "owner" | "participant" | "delay_signer" | "guardian_or_heir") => ({ sender, role, method: "claim" as const, args: {}, owner: "kemi.testnet" });
  it("only sponsors people who hold the role in that plan", () => {
    expect(holdsRole(plan, intent("amara.testnet", "heir"))).toBe(true);
    expect(holdsRole(plan, intent("dayo.testnet", "heir"))).toBe(false);
    expect(holdsRole(plan, intent("dayo.testnet", "guardian"))).toBe(true);
    expect(holdsRole(plan, intent("amara.testnet", "guardian"))).toBe(false);
    expect(holdsRole(plan, intent("kemi.testnet", "owner"))).toBe(true);
    expect(holdsRole(plan, intent("amara.testnet", "owner"))).toBe(false);
    expect(holdsRole(null, intent("amara.testnet", "heir"))).toBe(false);
  });
  it("sponsors proposals from guardians and (for follow-up rounds) heirs, not the owner", () => {
    expect(holdsRole(plan, intent("dayo.testnet", "guardian_or_heir"))).toBe(true);
    expect(holdsRole(plan, intent("amara.testnet", "guardian_or_heir"))).toBe(true);
    expect(holdsRole(plan, intent("kemi.testnet", "guardian_or_heir"))).toBe(false);
    expect(holdsRole(plan, intent("stranger.testnet", "guardian_or_heir"))).toBe(false);
  });
  it("treats a reassigned alternate as a heir and sponsors reassignment for participants only", () => {
    const withAlt = { plan: { ...plan.plan, proposal: { transfers: [{ heir: "ngozi.testnet" }] } } };
    expect(holdsRole(withAlt, intent("ngozi.testnet", "heir"))).toBe(true);
    expect(holdsRole(plan, intent("ngozi.testnet", "heir"))).toBe(false);
    expect(holdsRole(plan, intent("dayo.testnet", "participant"))).toBe(true);
    expect(holdsRole(plan, intent("stranger.testnet", "participant"))).toBe(false);
  });
  it("sponsors extension votes only for the plan's delay signers", () => {
    expect(holdsRole({ ...plan, delay_signers: ["ife.testnet"] }, intent("ife.testnet", "delay_signer"))).toBe(true);
    expect(holdsRole(plan, intent("ife.testnet", "delay_signer"))).toBe(false);
    expect(holdsRole({ ...plan, delay_signers: ["ife.testnet"] }, intent("dayo.testnet", "delay_signer"))).toBe(false);
  });
});

describe("Limiter", () => {
  it("limits per sender per hour and globally per day", () => {
    let t = 0;
    const l = new Limiter(2, 3, () => t);
    expect([l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, false]);
    expect(l.take("b")).toBe(true);
    expect(l.take("c")).toBe(false); // global cap of 3 reached
    t += 86_400_001;
    expect(l.take("a")).toBe(true);
  });
});
