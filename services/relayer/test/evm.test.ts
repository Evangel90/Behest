import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { isCanonicalSignature, parseSignedAction, signedActionMessage, type SignedAction } from "../src/evm.js";
import { PolicyError, checkEvm, holdsRole } from "../src/policy.js";

const C = "behest.testnet";
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const guardian = privateKeyToAccount(`0x${"22".repeat(32)}`);
const NOW = 1_700_000_000_000;

const action = (over: Partial<SignedAction> = {}): SignedAction => ({
  contract: C,
  network: "testnet",
  actor: owner.address.toLowerCase(),
  method: "check_in",
  args: {},
  nonce: "0",
  deadline_ms: String(NOW + 600_000),
  ...over,
});

async function signed(over: Partial<SignedAction> = {}, key = owner, summary = "Check in") {
  const message = signedActionMessage(summary, action(over));
  return { message, signature: await key.signMessage({ message }) };
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof PolicyError ? e.code : `unexpected ${String(e)}`;
  }
  return undefined;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function highS(sig: string): string {
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130), 16);
  return `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
}

describe("signed action format", () => {
  it("builds the exact text with fixed field order", () => {
    const m = signedActionMessage("Check in", action({ deadline_ms: "5", nonce: "1" }));
    expect(m).toBe(
      `Behest signed action\nCheck in\n\n{"contract":"behest.testnet","network":"testnet","actor":"${owner.address.toLowerCase()}","method":"check_in","args":{},"nonce":"1","deadline_ms":"5"}`,
    );
    expect(parseSignedAction(m).action.nonce).toBe("1");
    expect(() => signedActionMessage("two\nlines", action())).toThrow();
  });

  it("matches the contract's test vectors", () => {
    const v = JSON.parse(readFileSync(new URL("../../../contracts/behest/src/testdata/evm-vectors.json", import.meta.url), "utf8"));
    const { message } = v.vectors.owner_set_plan;
    expect(parseSignedAction(message).action.method).toBe("set_plan");
    expect(isCanonicalSignature(v.vectors.owner_set_plan.signature)).toBe(true);
    expect(isCanonicalSignature(v.vectors.high_s.signature)).toBe(false);
  });

  it.each([
    ["no header", "Hello\nx\n\n{}"],
    ["no blank line", "Behest signed action\nx\n{}"],
    ["two summary lines", 'Behest signed action\na\nb\n\n{"contract":"x"}'],
    ["missing fields", 'Behest signed action\nx\n\n{"contract":"behest.testnet"}'],
    ["extra fields", `Behest signed action\nx\n\n${JSON.stringify({ ...action(), extra: 1 })}`],
    ["numeric nonce", `Behest signed action\nx\n\n${JSON.stringify({ ...action(), nonce: 1 })}`],
    ["padded nonce", `Behest signed action\nx\n\n${JSON.stringify({ ...action(), nonce: "01" })}`],
    ["array args", `Behest signed action\nx\n\n${JSON.stringify({ ...action(), args: [] })}`],
  ])("refuses %s", (_n, m) => {
    expect(() => parseSignedAction(m)).toThrow();
  });
});

describe("checkEvm", () => {
  it("accepts a signed check-in and makes the actor the sender and owner", async () => {
    const { message, signature } = await signed();
    const intent = await checkEvm(message, signature, C, NOW);
    expect(intent).toMatchObject({ sender: owner.address.toLowerCase(), owner: owner.address.toLowerCase(), method: "check_in", role: "owner_or_delegate", nonce: 0n });
  });

  it("takes the owner from args for guardian methods", async () => {
    const { message, signature } = await signed({ actor: guardian.address.toLowerCase(), method: "approve_release", args: { owner: "kemi.testnet", proposal_id: 1 } }, guardian);
    const intent = await checkEvm(message, signature, C, NOW);
    expect(intent).toMatchObject({ sender: guardian.address.toLowerCase(), owner: "kemi.testnet", role: "guardian" });
    const plan = { plan: { owner: "kemi.testnet", policy: { guardians: [guardian.address.toLowerCase()], heirs: [] } } };
    expect(holdsRole(plan, intent)).toBe(true);
    expect(holdsRole({ plan: { ...plan.plan, policy: { guardians: ["dayo.testnet"], heirs: [] } } }, intent)).toBe(false);
  });

  it("allows owner withdrawals and plan creation, never deposits or admin calls", async () => {
    for (const method of ["withdraw", "withdraw_vault", "set_plan", "set_release_options"]) {
      const { message, signature } = await signed({ method, args: {} });
      expect((await checkEvm(message, signature, C, NOW)).method).toBe(method);
    }
    for (const method of ["deposit", "set_paused", "add_executor", "evm_call", "report_confirmed", "fund_sponsor_pool"]) {
      const { message, signature } = await signed({ method, args: {} });
      expect(await code(checkEvm(message, signature, C, NOW))).toBe("EVM_METHOD");
    }
  });

  it("refuses an owner method naming someone else's plan", async () => {
    const { message, signature } = await signed({ method: "cancel_vault_withdrawal", args: { owner: "kemi.testnet" } });
    expect(await code(checkEvm(message, signature, C, NOW))).toBe("BAD_ARGS");
  });

  it.each([
    ["another contract", { contract: "evil.testnet" }, "EVM_WRONG_CONTRACT"],
    ["another network", { network: "mainnet" as const }, "EVM_WRONG_CONTRACT"],
    ["someone else as actor", { actor: guardian.address.toLowerCase() }, "EVM_ACTOR"],
    ["an expired deadline", { deadline_ms: String(NOW - 1) }, "EVM_EXPIRED"],
  ])("refuses %s", async (_n, over, want) => {
    const { message, signature } = await signed(over);
    expect(await code(checkEvm(message, signature, C, NOW))).toBe(want);
  });

  it("refuses malleable, short, long and tampered signatures", async () => {
    const { message, signature } = await signed();
    expect(await code(checkEvm(message, highS(signature), C, NOW))).toBe("EVM_SIGNATURE");
    expect(await code(checkEvm(message, signature.slice(0, -2), C, NOW))).toBe("EVM_SIGNATURE");
    expect(await code(checkEvm(message, `${signature}00`, C, NOW))).toBe("EVM_SIGNATURE");
    expect(await code(checkEvm(message, `${signature.slice(0, -2)}1d`, C, NOW))).toBe("EVM_SIGNATURE");
    expect(await code(checkEvm(message.replace("Check in", "Check in!"), signature, C, NOW))).toBe("EVM_ACTOR");
    expect(await code(checkEvm(undefined, signature, C, NOW))).toBe("BAD_REQUEST");
  });

  it("accepts v as 0/1", async () => {
    const { message, signature } = await signed();
    const v = parseInt(signature.slice(130), 16) - 27;
    const intent = await checkEvm(message, `${signature.slice(0, 130)}0${v}`, C, NOW);
    expect(intent.sender).toBe(owner.address.toLowerCase());
  });
});
