// What the relayer will pay gas for. The relayer only ever pays NEAR gas: it
// cannot attach deposits, choose methods outside the allowlist, or act for
// anyone. The Behest contract still authorizes every call on its own.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deserialize } from "borsh";
import { SCHEMA, encodeDelegateAction } from "near-api-js";

import { SPONSORED_METHODS, type Role, type SponsoredMethod } from "./methods.js";

export { SPONSORED_METHODS, type Role, type SponsoredMethod };

export const MAX_GAS = 300_000_000_000_000n;

export interface DecodedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: Array<Record<string, unknown>>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: number[] | Uint8Array } };
  };
  signature: { ed25519Signature?: { data: number[] | Uint8Array } };
}

export interface CallIntent {
  sender: string;
  method: SponsoredMethod;
  args: Record<string, unknown>;
  /** Plan owner the call is about (args.owner, or the sender for owner methods). */
  owner: string;
  role: Role;
}

export class PolicyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function decode(bytes: Uint8Array): DecodedDelegate {
  try {
    return deserialize(SCHEMA.SignedDelegate, bytes) as unknown as DecodedDelegate;
  } catch {
    throw new PolicyError("BAD_ENCODING", "not a borsh-encoded SignedDelegate");
  }
}

/** Structural checks: one call, to the Behest contract, allowlisted, no deposit, bounded gas, valid signature. */
export function check(sd: DecodedDelegate, contractId: string): CallIntent {
  const da = sd.delegateAction;
  if (da.receiverId !== contractId) throw new PolicyError("WRONG_RECEIVER", `receiver must be ${contractId}`);
  if (da.actions.length !== 1) throw new PolicyError("ONE_ACTION", "exactly one action is sponsored");
  const fc = (da.actions[0] as { functionCall?: { methodName: string; args: number[] | Uint8Array; gas: bigint; deposit: bigint } }).functionCall;
  if (!fc) throw new PolicyError("NOT_FUNCTION_CALL", "only function calls are sponsored");
  if (!(fc.methodName in SPONSORED_METHODS)) throw new PolicyError("METHOD_NOT_SPONSORED", `${fc.methodName} is not sponsored`);
  if (BigInt(fc.deposit) !== 0n) throw new PolicyError("DEPOSIT", "sponsored calls cannot attach a deposit");
  if (BigInt(fc.gas) > MAX_GAS) throw new PolicyError("GAS", "gas above 300 Tgas");

  const pk = da.publicKey.ed25519Key?.data;
  const sig = sd.signature.ed25519Signature?.data;
  if (!pk || !sig) throw new PolicyError("KEY_TYPE", "only ed25519 keys are supported");
  const hash = sha256(encodeDelegateAction(da as never));
  if (!ed25519.verify(Uint8Array.from(sig), hash, Uint8Array.from(pk))) throw new PolicyError("BAD_SIGNATURE", "delegate signature does not verify");

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args)));
  } catch {
    throw new PolicyError("BAD_ARGS", "arguments must be JSON");
  }
  const method = fc.methodName as SponsoredMethod;
  const role = SPONSORED_METHODS[method];
  const owner = role === "owner" ? da.senderId : String(args.owner ?? "");
  if (!owner) throw new PolicyError("BAD_ARGS", "missing owner");
  return { sender: da.senderId, method, args, owner, role };
}

interface PlanRoles {
  plan: { owner: string; policy: { guardians: string[]; heirs: { account_id: string }[] }; proposal?: { transfers: { heir: string }[] } | null };
  /** From `get_release_options`, fetched only for delay-signer methods. */
  delay_signers?: string[];
}

/** The sender must actually hold the role in that plan; strangers aren't sponsored. */
export function holdsRole(plan: PlanRoles | null, intent: CallIntent): boolean {
  if (!plan) return false;
  switch (intent.role) {
    case "owner":
      return plan.plan.owner === intent.sender;
    case "guardian":
      return plan.plan.policy.guardians.includes(intent.sender);
    case "heir":
      // A named alternate or the fallback holds a transfer once it was reassigned to them.
      return plan.plan.policy.heirs.some((h) => h.account_id === intent.sender) || (plan.plan.proposal?.transfers ?? []).some((t) => t.heir === intent.sender);
    case "delay_signer":
      return (plan.delay_signers ?? []).includes(intent.sender);
    case "guardian_or_heir":
      return plan.plan.policy.guardians.includes(intent.sender) || plan.plan.policy.heirs.some((h) => h.account_id === intent.sender);
    case "participant":
      return plan.plan.owner === intent.sender || plan.plan.policy.guardians.includes(intent.sender) || holdsRole(plan, { ...intent, role: "heir" });
  }
}

/** Sliding-window limiter per sender plus a global daily cap. */
export class Limiter {
  private hits = new Map<string, number[]>();
  private day: { start: number; count: number } = { start: 0, count: 0 };
  constructor(
    private perSenderPerHour: number,
    private globalPerDay: number,
    private now: () => number = Date.now,
  ) {}

  take(sender: string): boolean {
    const t = this.now();
    if (t - this.day.start > 86_400_000) this.day = { start: t, count: 0 };
    if (this.day.count >= this.globalPerDay) return false;
    const recent = (this.hits.get(sender) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= this.perSenderPerHour) return false;
    recent.push(t);
    this.hits.set(sender, recent);
    this.day.count++;
    return true;
  }
}
