// What the relayer will pay gas for. The relayer only ever pays NEAR gas: it
// cannot attach deposits, choose methods outside the allowlist, or act for
// anyone. The Behest contract still authorizes every call on its own.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deserialize } from "borsh";
import { SCHEMA, encodeDelegateAction } from "near-api-js";

import { recoverMessageAddress } from "viem";
import { isCanonicalSignature, networkOf, parseSignedAction, SignedActionError } from "./evm.js";
import { EVM_METHODS, SPONSORED_METHODS, type EvmMethod, type Role, type SponsoredMethod } from "./methods.js";

export { EVM_METHODS, SPONSORED_METHODS, type EvmMethod, type Role, type SponsoredMethod };

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
  method: EvmMethod;
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
  return intentOf(da.senderId, method, SPONSORED_METHODS[method], args);
}

function intentOf(sender: string, method: EvmMethod, role: Role, args: Record<string, unknown>): CallIntent {
  // Owner methods act on the sender's own plan; one naming an owner must name the sender.
  const own = role === "owner" || role === "self";
  if (own && args.owner !== undefined && args.owner !== sender) throw new PolicyError("BAD_ARGS", "owner methods act on the sender's own plan");
  // D26: a check-in names the plan it is for; without a name it is the sender's own.
  const owner = own ? sender : role === "owner_or_delegate" ? String(args.owner ?? sender) : String(args.owner ?? "");
  if (!owner) throw new PolicyError("BAD_ARGS", "missing owner");
  return { sender, method, args, owner, role };
}

export interface EvmIntent extends CallIntent {
  nonce: bigint;
  deadlineMs: bigint;
}

/**
 * D23 structural checks on a signed action, mirroring the contract: header
 * and JSON, this contract and network, a canonical 65-byte low-S signature
 * that recovers to `actor`, an allowlisted method, and an unexpired deadline.
 * The sender is the actor's eth-implicit account (`0x…`, lowercase).
 */
export async function checkEvm(message: unknown, signature: unknown, contractId: string, now: number = Date.now()): Promise<EvmIntent> {
  if (typeof message !== "string" || typeof signature !== "string") throw new PolicyError("BAD_REQUEST", "message and signature are required");
  let action;
  try {
    action = parseSignedAction(message).action;
  } catch (e) {
    if (e instanceof SignedActionError) throw new PolicyError(e.code, e.message);
    throw e;
  }
  if (action.contract !== contractId || action.network !== networkOf(contractId)) throw new PolicyError("EVM_WRONG_CONTRACT", `signed for ${action.contract} on ${action.network}, not ${contractId}`);
  if (!isCanonicalSignature(signature)) throw new PolicyError("EVM_SIGNATURE", "signature must be 65 bytes (r‖s‖v) with a low s");
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase();
  } catch {
    throw new PolicyError("EVM_SIGNATURE", "signature does not recover");
  }
  if (action.actor.toLowerCase() !== signer) throw new PolicyError("EVM_ACTOR", "the signature is not the actor's");
  if (!(action.method in EVM_METHODS)) throw new PolicyError("EVM_METHOD", `${action.method} can't be called with an EVM signature`);
  const deadlineMs = BigInt(action.deadline_ms);
  if (BigInt(now) > deadlineMs) throw new PolicyError("EVM_EXPIRED", "the signed action expired; sign again");
  const method = action.method as EvmMethod;
  return { ...intentOf(signer, method, EVM_METHODS[method], action.args), nonce: BigInt(action.nonce), deadlineMs };
}

interface PlanRoles {
  plan: { owner: string; policy: { guardians: string[]; heirs: { account_id: string }[] }; proposal?: { transfers: { heir: string }[] } | null };
  /** From `get_release_options`, fetched only for delay-signer methods. */
  delay_signers?: string[];
  /** D26: from `get_checkin_delegates`, fetched only for check-ins naming another owner. */
  checkin_delegates?: string[];
  /** D29: from `get_guardian_settings`, fetched only for methods standbys may call. */
  standbys?: string[];
  /** D17/D31: named alternates and the fallback (`get_release_rules`). */
  recipients?: string[];
  /** D30: every registered and requested destination (`get_destinations`, `get_destination_requests`). */
  destinations?: string[];
}

/** The sender must actually hold the role in that plan; strangers aren't sponsored. */
export function holdsRole(plan: PlanRoles | null, intent: CallIntent): boolean {
  // set_plan creates or replaces the sender's own plan: anyone may (the
  // contract caps sponsored storage per owner and new plans per day).
  if (intent.role === "self") return true;
  if (!plan) return false;
  switch (intent.role) {
    case "owner":
      return plan.plan.owner === intent.sender;
    case "owner_or_delegate":
      return plan.plan.owner === intent.sender || (plan.checkin_delegates ?? []).includes(intent.sender);
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
    case "guardian_or_standby":
      return plan.plan.policy.guardians.includes(intent.sender) || (plan.standbys ?? []).includes(intent.sender);
    case "participant_or_standby":
      return holdsRole(plan, { ...intent, role: "participant" }) || (plan.standbys ?? []).includes(intent.sender);
    case "recipient":
      return plan.plan.policy.heirs.some((h) => h.account_id === intent.sender) || (plan.recipients ?? []).includes(intent.sender);
    case "participant_or_destination":
      return holdsRole(plan, { ...intent, role: "participant" }) || (plan.recipients ?? []).includes(intent.sender) || (plan.destinations ?? []).includes(intent.sender);
    case "owner_or_guardian":
      return plan.plan.owner === intent.sender || plan.plan.policy.guardians.includes(intent.sender);
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
