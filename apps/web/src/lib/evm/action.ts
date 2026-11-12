// D23 signed actions: the exact text an Ethereum wallet signs with
// personal_sign so the Behest contract can act as the wallet's 0x account.
// Pure (no I/O), so the format is unit-tested against the spec.
//
//   Behest signed action
//   <summary, for the human; the contract ignores it>
//
//   {"contract":…,"network":…,"actor":"0x…","method":…,"args":{…},"nonce":"7","deadline_ms":"…"}
import { shortAddr, shortName } from "../plan";

export const SIGNED_ACTION_HEADER = "Behest signed action";
/** How long a signature stays valid (the spec's "now + 10 min"). */
export const DEADLINE_MS = 10 * 60_000;

/** Methods whose attached deposit only pays for storage: an Ethereum wallet sends them with none, and Behest's sponsor pool pays (D24). */
export const STORAGE_METHODS = new Set(["set_plan", "set_release_rules", "set_release_options", "set_btc_destinations", "set_intents_delivery", "set_edit_notice", "set_guardian_settings", "respond_destination_change", "set_private_plan"]);

/** testnet or mainnet, from the contract's account suffix (as the contract derives it). */
export const networkOf = (contractId: string): "mainnet" | "testnet" => (contractId.endsWith(".near") ? "mainnet" : "testnet");

export const isEthAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

export interface SignedActionInput {
  contract: string;
  actor: string;
  method: string;
  args: Record<string, unknown>;
  nonce: bigint | number | string;
  deadlineMs: bigint | number | string;
  summary: string;
  network?: "mainnet" | "testnet";
}

/** The exact UTF-8 text the wallet signs. Key order is fixed; numbers that can exceed 2^53 are decimal strings. */
export function signedActionMessage(a: SignedActionInput): string {
  if (!isEthAddress(a.actor)) throw new Error(`Not an Ethereum address: ${a.actor}`);
  const body = {
    contract: a.contract,
    network: a.network ?? networkOf(a.contract),
    actor: a.actor.toLowerCase(),
    method: a.method,
    args: a.args,
    nonce: BigInt(a.nonce).toString(),
    deadline_ms: BigInt(a.deadlineMs).toString(),
  };
  return `${SIGNED_ACTION_HEADER}\n${oneLine(a.summary)}\n\n${JSON.stringify(body)}`;
}

/** Reads a signed-action text back (tests, and showing what was signed). */
export function parseSignedAction(message: string): { summary: string; body: Record<string, unknown> } {
  const [head, summary = "", blank, ...rest] = message.split("\n");
  if (head !== SIGNED_ACTION_HEADER || blank !== "") throw new Error("Not a Behest signed action.");
  return { summary, body: JSON.parse(rest.join("\n")) as Record<string, unknown> };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim() || "Behest action";

/** "Kemi's plan", "your plan", or "0x71c7…976f's plan". */
export function planName(owner: unknown, actor: string): string {
  if (typeof owner !== "string" || !owner) return "the plan";
  if (owner.toLowerCase() === actor.toLowerCase()) return "your plan";
  return `${shortName(owner)}'s plan`;
}

const who = (a: unknown) => (typeof a === "string" ? shortName(a) : "an heir");

/** The summary line: what the signature does, in plain words. */
export function describeAction(method: string, args: Record<string, unknown>, actor: string): string {
  const plan = planName(args.owner, actor);
  const n = typeof args.proposal_id === "number" || typeof args.proposal_id === "string" ? ` #${args.proposal_id}` : "";
  const t = typeof args.index === "number" ? ` #${args.index + 1}` : "";
  switch (method) {
    case "set_plan":
      return "Save your inheritance plan";
    case "check_in":
      return "Check in on your plan";
    case "cancel_release":
      return "Cancel the open release of your plan";
    case "propose_release":
      return `Propose a release of ${plan}`;
    case "approve_release":
      return `Approve release${n} of ${plan}`;
    case "reject_release":
      return `Reject release${n} of ${plan}`;
    case "claim":
      return `Claim your share of ${plan}`;
    case "release":
      return `Pay out ${who(args.heir)}'s share of ${plan}`;
    case "retry_transfer":
      return `Retry payout${t} of ${plan}`;
    case "reassign_unclaimed":
      return `Pass on unclaimed payout${t} of ${plan}`;
    case "request_extension":
      return `Ask for more time on release${n} of ${plan}`;
    case "approve_extension":
      return `Approve more time on release${n} of ${plan}`;
    case "register_btc_vault":
      return `Set up the Bitcoin vault of ${plan}`;
    case "rebase_btc":
      return `Update the Bitcoin coins of ${plan}`;
    case "set_release_rules":
      return args.rules ? "Save your plan's release rules" : "Clear your plan's release rules";
    case "set_release_options":
      return args.options ? "Save your plan's release options" : "Clear your plan's release options";
    case "set_btc_destinations":
      return "Save your heirs' Bitcoin addresses";
    case "withdraw":
      return "Withdraw NEAR from your plan";
    case "withdraw_ft":
      return "Withdraw tokens from your plan";
    case "withdraw_vault":
      return `Withdraw from your Ethereum vault to ${typeof args.to === "string" ? shortAddr(args.to) : "your address"}`;
    case "withdraw_btc":
      return "Withdraw from your Bitcoin vault";
    case "cancel_vault_withdrawal":
      return "Cancel your vault withdrawal";
    case "set_checkin_delegates":
      return Array.isArray(args.delegates) && args.delegates.length ? `Let ${(args.delegates as string[]).join(", ")} check in for you` : "Remove your check-in delegates";
    case "set_intents_delivery": {
      const ds = Array.isArray(args.deliveries) ? (args.deliveries as { account_id: string; enabled: boolean }[]).filter((x) => x.enabled) : [];
      return ds.length ? `Pay ${ds.map((x) => x.account_id).join(", ")} through NEAR Intents` : "Stop paying heirs through NEAR Intents";
    }
    // D28
    case "set_edit_notice":
      return Number(args.notice_ms) ? "Set your plan's edit notice" : "Turn your plan's edit notice off";
    case "cancel_change":
      return "Cancel a waiting change to your plan";
    case "apply_changes":
      return `Apply the waiting changes to ${plan}`;
    // D29
    case "set_guardian_settings":
      return args.settings ? "Save your standby guardians" : "Remove your standby guardians";
    case "confirm_guardian":
      return `Confirm you're available for ${plan}`;
    case "request_standby":
      return `Ask a standby to take a guardian seat on ${plan}`;
    case "rotate_guardian":
      return `Move your guardian seat on ${plan} to ${String(args.new_account)}`;
    case "resign_guardian":
      return `Step down as a guardian of ${plan}`;
    case "finalize_guardian_change":
      return `Complete a guardian seat change on ${plan}`;
    case "cancel_guardian_change":
      return `Cancel a guardian seat change on ${plan}`;
    case "prove_destination":
      return `Prove control of ${String(args.destination)} for ${String(args.account_id)} on ${plan}`;
    case "request_destination_change":
      return `Ask ${plan}'s owner to pay you at ${String(args.destination)} (${String(args.chain)})`;
    case "cancel_destination_change":
      return `Withdraw your address request on ${plan}`;
    case "respond_destination_change":
      return `${args.approve ? "Approve" : "Reject"} ${String(args.account_id)}'s new ${String(args.chain)} address`;
    // D33
    case "set_private_plan":
      return "Save your private inheritance plan";
    case "reveal_heir":
      return `Reveal ${String((args.record as { account_id?: string } | undefined)?.account_id ?? "a heir")} as a heir of ${plan}`;
    default:
      return `Call ${method} on Behest`;
  }
}
