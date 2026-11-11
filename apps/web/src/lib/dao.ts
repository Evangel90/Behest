// D26: acting as a DAO (SputnikDAO v2, which Trezu manages). Behest checks the
// calling account, so a DAO can own, guard, inherit or delay-sign like anyone:
// every call the app would make becomes an `add_proposal` on the DAO with the
// FunctionCall kind, the DAO's bond attached and a plain-words description
// (Trezu shows it). The call runs as the DAO once the council approves.
import { CONTRACT_ID } from "./config";
import { view } from "./contract";
import { describeAction } from "./evm/action";

export type RoleKind = "Everyone" | { Group: string[] } | { Member: string };
export interface DaoRole {
  name: string;
  kind: RoleKind;
  permissions: string[];
  vote_policy?: Record<string, VotePolicy>;
}
export interface VotePolicy {
  weight_kind: string;
  quorum: string;
  threshold: [number, number] | string;
}
export interface DaoPolicy {
  roles: DaoRole[];
  default_vote_policy: VotePolicy;
  proposal_bond: string;
  /** Nanoseconds, as a string. */
  proposal_period: string;
  bounty_bond?: string;
  bounty_forgiveness_period?: string;
}

export interface FunctionCallAction {
  method_name: string;
  /** base64 JSON */
  args: string;
  deposit: string;
  gas: string;
}
export type ProposalStatus = "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";
export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: { FunctionCall?: { receiver_id: string; actions: FunctionCallAction[] } } & Record<string, unknown>;
  status: ProposalStatus;
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  /** Nanoseconds, as a string. */
  submission_time: string;
}

export interface DaoCall {
  method: string;
  args: Record<string, unknown>;
  deposit?: bigint;
  tgas?: number;
  /** Another contract (e.g. the fee token for ft_transfer_call); Behest by default. */
  receiverId?: string;
}

/** DAOs on Sputnik v2's factory. Any account with get_policy works; this is what the picker suggests. */
export const DAO_SUFFIX = CONTRACT_ID.endsWith(".near") ? ".sputnik-dao.near" : ".sputnikv2.testnet";
export const looksLikeDao = (a: string) => a.endsWith(DAO_SUFFIX);

/** Each proposal action's gas; act_proposal runs it with the vote, so it must fit under 300 Tgas with room to spare. */
export const ACTION_TGAS_MAX = 150;
/** Gas for the vote that executes a proposal. */
export const VOTE_TGAS = 300;

const NS_PER_MS = 1_000_000n;

export const getPolicy = (dao: string) => view<DaoPolicy>("get_policy", {}, dao);

export async function isDao(account: string): Promise<boolean> {
  try {
    await getPolicy(account);
    return true;
  } catch {
    return false;
  }
}

/** The account's roles in the DAO (Everyone always applies). */
export function rolesOf(policy: DaoPolicy, account: string): DaoRole[] {
  return policy.roles.filter((r) => r.kind === "Everyone" || ("Group" in (r.kind as object) && (r.kind as { Group: string[] }).Group.includes(account)) || ("Member" in (r.kind as object) && (r.kind as { Member: string }).Member === account));
}

const grants = (perms: string[], kind: string, action: string) => perms.some((p) => p === "*:*" || p === `*:${action}` || p === `${kind}:*` || p === `${kind}:${action}`);

/** What the account may do with FunctionCall proposals, from its roles' permissions. */
export function powers(policy: DaoPolicy, account: string) {
  const perms = rolesOf(policy, account).flatMap((r) => r.permissions);
  return {
    propose: grants(perms, "call", "AddProposal"),
    approve: grants(perms, "call", "VoteApprove"),
    reject: grants(perms, "call", "VoteReject"),
  };
}

/** Every member of a Group role: the council the notifier can subscribe. */
export function councilOf(policy: DaoPolicy): string[] {
  const out = new Set<string>();
  for (const r of policy.roles) if (typeof r.kind === "object" && "Group" in r.kind) r.kind.Group.forEach((m) => out.add(m));
  return [...out].sort();
}

/** "2 of 3 council votes" for the FunctionCall policy of the role that votes, for display. */
export function voteRule(policy: DaoPolicy): string {
  const council = policy.roles.find((r) => typeof r.kind === "object" && "Group" in r.kind && grants(r.permissions, "call", "VoteApprove"));
  if (!council || typeof council.kind !== "object" || !("Group" in council.kind)) return "the DAO's vote";
  const n = council.kind.Group.length;
  const vp = council.vote_policy?.call ?? council.vote_policy?.FunctionCall ?? policy.default_vote_policy;
  if (Array.isArray(vp.threshold)) {
    const [a, b] = vp.threshold;
    // Sputnik: more than a/b of the weight is needed, i.e. floor(n*a/b)+1 votes (capped at n).
    const need = Math.min(n, Math.floor((n * a) / b) + 1);
    return `${need} of ${n} ${council.name} vote${need === 1 ? "" : "s"}`;
  }
  return `${vp.threshold} ${council.name} weight`;
}

export const proposalPeriodMs = (p: DaoPolicy) => Number(BigInt(p.proposal_period) / NS_PER_MS);

const b64 = (o: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
};
export const unb64 = (s: string): Record<string, unknown> | null => {
  try {
    const bin = atob(s);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Plain words for a call made by a DAO, shown in the proposal (and so in Trezu). */
export function describeDaoCall(dao: string, c: DaoCall, feeToken?: string | null): string {
  const r = c.receiverId ?? CONTRACT_ID;
  if (r !== CONTRACT_ID) {
    if (c.method === "ft_transfer_call" && typeof c.args.msg === "string" && c.args.msg.includes("pay_tier")) {
      let owner = dao;
      try {
        owner = (JSON.parse(c.args.msg) as { pay_tier?: string }).pay_tier ?? dao;
      } catch {}
      const amt = typeof c.args.amount === "string" && r === feeToken ? ` (${Number(BigInt(c.args.amount)) / 1e6} USDC)` : "";
      return `Pay the Behest plan tier for ${owner === dao ? "this DAO" : owner}${amt}`;
    }
    return `Call ${c.method} on ${r}`;
  }
  // The action wording says "your plan"; for a DAO, "the DAO's plan".
  return describeAction(c.method, c.args, dao).replace(/\byour plan\b/g, "the DAO's plan").replace(/\byour heirs\b/g, "the DAO's heirs").replace(/^Claim your share/, "Claim the DAO's share").replace(/\byour inheritance plan\b/g, "the DAO's inheritance plan");
}

/**
 * add_proposal arguments for one or more calls to the same contract (one vote
 * runs them all, in order, in one receipt: they succeed or fail together).
 */
export function proposalArgs(dao: string, calls: DaoCall[], description?: string, feeToken?: string | null) {
  if (calls.length === 0) throw new Error("Nothing to propose.");
  const receiver = calls[0]?.receiverId ?? CONTRACT_ID;
  if (calls.some((c) => (c.receiverId ?? CONTRACT_ID) !== receiver)) throw new Error("One proposal calls one contract.");
  const words = description ?? calls.map((c) => describeDaoCall(dao, c, feeToken)).join(", then ");
  return {
    proposal: {
      // Sputnik shows the description as text; the marker lets Behest find its own proposals.
      description: `${words} · via Behest`,
      kind: {
        FunctionCall: {
          receiver_id: receiver,
          actions: calls.map((c) => ({
            method_name: c.method,
            args: b64(c.args),
            deposit: (c.deposit ?? 0n).toString(),
            gas: (BigInt(Math.min(c.tgas ?? 100, ACTION_TGAS_MAX)) * 1_000_000_000_000n).toString(),
          })),
        },
      },
    },
  };
}

/** The most recent proposals of the DAO, newest first. */
export async function recentProposals(dao: string, limit = 50): Promise<DaoProposal[]> {
  const last = await view<number>("get_last_proposal_id", {}, dao);
  const from = Math.max(0, last - limit);
  const list = await view<DaoProposal[]>("get_proposals", { from_index: from, limit }, dao);
  return list.sort((a, b) => b.id - a.id);
}

/** Does this proposal call Behest (or pay its fee token) about `owner`'s plan? */
export function concerns(p: DaoProposal, dao: string, owner: string, feeToken?: string | null): boolean {
  const fc = p.kind.FunctionCall;
  if (!fc) return false;
  if (fc.receiver_id === CONTRACT_ID) {
    return fc.actions.some((a) => {
      const args = unb64(a.args) ?? {};
      const about = typeof args.owner === "string" ? args.owner : dao;
      return about === owner;
    });
  }
  if (feeToken && fc.receiver_id === feeToken) {
    return fc.actions.some((a) => {
      const msg = (unb64(a.args) ?? {}).msg;
      return typeof msg === "string" && msg.includes(`"pay_tier":"${owner}"`);
    });
  }
  return false;
}

/** Proposal states that still need votes. */
export const isOpen = (p: DaoProposal, policy: DaoPolicy, nowMs = Date.now()) => p.status === "InProgress" && Number(BigInt(p.submission_time) / NS_PER_MS) + proposalPeriodMs(policy) > nowMs;

export const STATUS_WORDS: Record<ProposalStatus, string> = {
  InProgress: "Waiting for votes",
  Approved: "Approved and run",
  Rejected: "Rejected",
  Removed: "Removed",
  Expired: "Expired",
  Moved: "Moved",
  Failed: "Approved, but the call failed",
};

/** Trezu's page for a proposal (mainnet DAOs; Trezu doesn't list testnet DAOs). */
export const trezuUrl = (dao: string, id?: number) => `https://trezu.org/${encodeURIComponent(dao)}/requests${id === undefined ? "" : `/${id}`}`;
export const trezuAvailable = CONTRACT_ID.endsWith(".near");

export const formatNear = (yocto: string | bigint) => {
  const v = Number(BigInt(yocto) / 10n ** 20n) / 1e4;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR`;
};

export function formatPeriod(ms: number): string {
  const d = ms / 86_400_000;
  if (d >= 1) return `${Math.round(d * 10) / 10} day${d === 1 ? "" : "s"}`;
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h * 10) / 10} hour${h === 1 ? "" : "s"}`;
  return `${Math.round(ms / 60_000)} minutes`;
}

/**
 * Wizard advice (D26): a DAO owner checks in by proposal, which takes up to
 * the proposal period to pass. The interval should leave room for several.
 */
export function checkInAdvice(intervalMs: number, policy: DaoPolicy): "ok" | "tight" | "too_short" {
  const period = proposalPeriodMs(policy);
  if (intervalMs <= period) return "too_short";
  if (intervalMs < 4 * period) return "tight";
  return "ok";
}
