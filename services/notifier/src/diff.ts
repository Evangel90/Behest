// Decides which notifications a plan change deserves. Pure: the caller keeps
// the previous snapshot and the set of keys already sent (so restarts don't
// repeat anything). The notifier only reads chain state; a missed or failed
// notification can never change what the contract does.

export type Status = "Active" | "Overdue" | "Proposed" | "Waiting" | "Eligible" | "Executing" | "Settled";
export type Audience = "owner" | "guardians" | "heirs";

export interface PlanView {
  status: Status;
  overdue_at_ms: number;
  now_ms: number;
  plan: {
    owner: string;
    last_check_in_ms: number;
    policy: { check_in_interval_ms: number; grace_ms: number; quorum: number; guardians: string[]; heirs: { account_id: string }[] };
    proposal: null | {
      id: number;
      approvals: string[];
      waiting_ends_at_ms: number | null;
      transfers: { heir: string; asset: string | { Erc20: string } | { Nep141: string }; amount: string; state: string; failure: string | null; attempts: number }[];
    };
    proposals_opened: number;
  };
}

export interface Notice {
  /** Stable id: the same event never produces two different keys. */
  key: string;
  owner: string;
  kind: "reminder" | "overdue" | "proposed" | "approved" | "cancelled" | "eligible" | "transfer_failed" | "settled";
  to: Audience[];
  text: string;
}

const name = (a: string) => {
  const f = a.split(".")[0] ?? a;
  const r = f.includes("-") ? f.slice(f.lastIndexOf("-") + 1) : f;
  return r.charAt(0).toUpperCase() + r.slice(1);
};

/** Reminder once 75% of the check-in window has passed. */
export const REMINDER_AT = 0.75;

export function notices(prev: PlanView | null, cur: PlanView): Notice[] {
  const out: Notice[] = [];
  const o = cur.plan.owner;
  const who = name(o);
  const p = cur.plan.proposal;
  const window = cur.plan.policy.check_in_interval_ms + cur.plan.policy.grace_ms;
  const checkIn = cur.plan.last_check_in_ms; // each check-in gets its own keys

  if (cur.status === "Active" && cur.now_ms >= cur.overdue_at_ms - window * (1 - REMINDER_AT)) {
    out.push({ key: `${o}:reminder:${checkIn}`, owner: o, kind: "reminder", to: ["owner"], text: `Reminder: check in before ${new Date(cur.overdue_at_ms).toUTCString()} so your guardians aren't asked to act.` });
  }
  if (cur.status === "Overdue") {
    out.push({ key: `${o}:overdue:${checkIn}`, owner: o, kind: "overdue", to: ["owner", "guardians"], text: `${who} hasn't checked in and is now counted as unreachable. Guardians can propose a release; ${who} can still check in.` });
  }
  if (p) {
    out.push({ key: `${o}:proposed:${p.id}`, owner: o, kind: "proposed", to: ["owner", "guardians"], text: `A release of ${who}'s plan was proposed (#${p.id}). ${cur.plan.policy.quorum} guardian approvals are needed. ${who} can cancel.` });
    if (p.waiting_ends_at_ms) {
      out.push({ key: `${o}:approved:${p.id}`, owner: o, kind: "approved", to: ["owner", "guardians", "heirs"], text: `Release #${p.id} of ${who}'s plan was approved. ${who} can cancel until ${new Date(p.waiting_ends_at_ms).toUTCString()}.` });
    }
    if (cur.status === "Eligible" || cur.status === "Executing" || cur.status === "Settled") {
      out.push({ key: `${o}:eligible:${p.id}`, owner: o, kind: "eligible", to: ["heirs"], text: `What ${who} set aside for you is ready. Open Behest to receive it; network fees are covered.` });
    }
    p.transfers.forEach((t, i) => {
      if (t.state === "Failed") {
        out.push({ key: `${o}:failed:${p.id}:${i}:${t.attempts}:${t.failure ?? "?"}`, owner: o, kind: "transfer_failed", to: ["heirs"], text: `${name(t.heir)}'s ${typeof t.asset === "object" ? "token" : t.asset.toUpperCase()} transfer from ${who}'s plan failed (${t.failure ?? "unknown"}). The funds are safe and it can be retried.` });
      }
    });
    if (cur.status === "Settled") {
      out.push({ key: `${o}:settled:${p.id}`, owner: o, kind: "settled", to: ["guardians", "heirs"], text: `Every transfer of ${who}'s plan has arrived. Receipts are in Behest.` });
    }
  }
  // A proposal that vanished without settling was cancelled by the owner.
  const prevP = prev?.plan.proposal;
  if (prevP && (!p || p.id !== prevP.id) && prev.status !== "Settled") {
    out.push({ key: `${o}:cancelled:${prevP.id}`, owner: o, kind: "cancelled", to: ["guardians", "heirs"], text: `${who} cancelled release #${prevP.id}. Nothing was sent.` });
  }
  return out;
}

/** Account ids for an audience of a plan. */
export function recipients(v: PlanView, to: Audience[]): string[] {
  const r = new Set<string>();
  if (to.includes("owner")) r.add(v.plan.owner);
  if (to.includes("guardians")) v.plan.policy.guardians.forEach((g) => r.add(g));
  if (to.includes("heirs")) v.plan.policy.heirs.forEach((h) => r.add(h.account_id));
  return [...r];
}
