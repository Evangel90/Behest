// Pure UI guidance: what the signed-in person should do now, the release
// timeline, live countdown text and transfer progress. No I/O, unit-tested.
import { LIFECYCLE, STATUS_STYLE, relative, shortName, when, type Role } from "./plan";
import type { PlanStatus, PlanView, TransferState } from "./types";

/** Roles the plan screen can show. "delay" is a delay signer (from the plan's release options). */
export type UiRole = Role | "delay" | "public";

export const ROLE_LABEL: Record<UiRole, string> = {
  owner: "Owner",
  guardian: "Guardian",
  heir: "Heir",
  delay: "Delay signer",
  public: "Public",
};

/** Compact live countdown: "2d 4h", "3h 12m", "4m 05s", "12s", or "now". */
export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** How far along a transfer is, 0..1, for the tracker bars. */
export const TRANSFER_PROGRESS: Record<TransferState, number> = {
  Pending: 0.06,
  Sending: 0.3,
  Signing: 0.4,
  Signed: 0.55,
  Broadcast: 0.78,
  Confirmed: 1,
  Failed: 1,
};

export type StepState = "done" | "current" | "upcoming";

export interface TimelineStep {
  status: PlanStatus;
  label: string;
  state: StepState;
  /** When this stage started (or will start), if known. */
  at: number | null;
  /** One plain line under the stage. */
  detail: string;
}

/**
 * The release lifecycle as a timeline. Stages before the current one are
 * done, later ones upcoming; times come from the plan where known.
 */
export function timeline(view: PlanView): TimelineStep[] {
  const at = LIFECYCLE.indexOf(view.status);
  const p = view.plan.proposal;
  const q = view.plan.policy;
  const times: Record<PlanStatus, number | null> = {
    Active: view.plan.last_check_in_ms || null,
    Overdue: view.overdue_at_ms || null,
    Proposed: p ? p.created_at_ms : null,
    Waiting: p?.approved_at_ms ?? null,
    Eligible: p?.waiting_ends_at_ms ?? null,
    Executing: null,
    Settled: null,
  };
  const details: Record<PlanStatus, string> = {
    Active: "The owner checks in now and then.",
    Overdue: q.grace_ms > 0 ? "A check-in was missed and the grace period ran out." : "A check-in was missed.",
    Proposed: `A guardian proposes; ${q.quorum} of ${q.guardians.length} must approve.`,
    Waiting: "The owner can still cancel.",
    Eligible: "Heirs can receive their shares.",
    Executing: "Transfers are on their way.",
    Settled: "Every transfer has landed.",
  };
  return LIFECYCLE.map((status, i) => ({
    status,
    label: STATUS_STYLE[status].label,
    state: i < at ? "done" : i === at ? "current" : "upcoming",
    at: times[status],
    detail: details[status],
  }));
}

export type Tone = "calm" | "attention" | "urgent" | "done";

export interface NextStep {
  tone: Tone;
  title: string;
  body: string;
  /** A moment the person should know about (cut-off, due date), with its label. */
  deadline?: { at: number; label: string };
}

export interface GuideCtx {
  /** The signed-in account. */
  me?: string | null;
  /** D21: a follow-up round is open. */
  followUp?: boolean;
  /** Chain clock. */
  now: number;
  /** Delay signer facts, from the plan's release options and extension state. */
  delay?: { pending: boolean; voted: boolean; capLeft: boolean };
}

/** What the person in `role` should do now, in plain words. Never implies the owner has died. */
export function nextStep(view: PlanView, role: UiRole, ctx: GuideCtx): NextStep {
  const s = view.status;
  const p = view.plan.proposal;
  const name = shortName(view.plan.owner);
  const { quorum } = view.plan.policy;
  const ends = p?.waiting_ends_at_ms ?? null;
  switch (role) {
    case "owner":
      if (s === "Active")
        return { tone: "calm", title: "You're all set.", body: `Your next check-in is due ${when(view.overdue_at_ms)}. Checking in early simply restarts the clock.`, deadline: { at: view.overdue_at_ms, label: "Check in within" } };
      if (s === "Overdue")
        return { tone: "attention", title: "Check in to stay in control.", body: "You missed a check-in, so your guardians can now propose a release. Checking in stops that." };
      if (s === "Proposed")
        return {
          tone: "urgent",
          title: "A release of your plan was proposed.",
          body: `Guardians think you may be unreachable. ${p ? `${p.approvals.length} of ${quorum} have approved so far.` : ""} If you're here, one tap stops everything.`.replace("  ", " "),
        };
      if (s === "Waiting")
        return {
          tone: "urgent",
          title: "Your plan was approved for release.",
          body: ends ? `If you're here, you can still stop it until ${when(ends)}.` : "If you're here, you can still stop it until the waiting period ends.",
          deadline: ends ? { at: ends, label: "Cancel within" } : undefined,
        };
      if (s === "Eligible") return { tone: "calm", title: "The waiting period has ended.", body: "Your heirs can now receive their shares. The release can no longer be cancelled." };
      if (s === "Executing") return { tone: "calm", title: "Transfers are on their way.", body: "Each heir's share is being sent to the addresses you chose." };
      return { tone: "done", title: "The release is complete.", body: "Check in to take the plan back, or withdraw what's left." };

    case "guardian": {
      const voted = !!ctx.me && !!p && (p.approvals.includes(ctx.me) || p.rejections.includes(ctx.me));
      if (s === "Active")
        return { tone: "calm", title: "Nothing for you to do yet.", body: `${name} is checking in. If that stops, you'll be able to propose a release ${relative(view.overdue_at_ms, ctx.now)}.`, deadline: { at: view.overdue_at_ms, label: "Earliest proposal in" } };
      if (s === "Overdue")
        return ctx.followUp
          ? { tone: "attention", title: "A follow-up release is possible.", body: `A release of ${name}'s plan completed and ${name} hasn't checked in since. Anything left can go out in a follow-up round.` }
          : { tone: "attention", title: `${name} hasn't checked in.`, body: `${name} has been unreachable since ${when(view.overdue_at_ms)}. If you believe they can't act, propose a release. ${name} can still cancel.` };
      if (s === "Proposed")
        return voted
          ? { tone: "calm", title: "You've voted.", body: `Waiting for the other guardians: ${p!.approvals.length} of ${quorum} approvals so far.` }
          : { tone: "attention", title: "Your vote is needed.", body: `Check the numbers, then approve or reject proposal #${p!.id}. ${p!.approvals.length} of ${quorum} approvals so far.` };
      if (s === "Waiting")
        return { tone: "calm", title: "Approved. Nothing more to do.", body: ends ? `${name} can still cancel until ${when(ends)}. Then the heirs can receive.` : `${name} can still cancel until the waiting period ends.`, deadline: ends ? { at: ends, label: "Waiting period ends in" } : undefined };
      if (s === "Eligible" || s === "Executing") return { tone: "calm", title: "Heirs can receive now.", body: "Your part is done. Transfers go only to the addresses in the plan." };
      return { tone: "done", title: "The release is complete.", body: "If anything was left in the plan, you can propose a follow-up round for it." };
    }

    case "heir": {
      const first = shortName(ctx.me ?? "");
      const mine = p?.transfers.filter((t) => t.heir === ctx.me) ?? [];
      const started = mine.some((t) => t.state !== "Pending");
      if (ctx.followUp && s === "Overdue")
        return { tone: "done", title: "Done.", body: `${name}'s release to you has completed. If anything was left in the plan, you can start a follow-up round below; guardians approve it.` };
      // A heir can be left out of a release: a share of 0, a share moved to an
      // alternate, or a follow-up round with nothing for them. Say so plainly
      // instead of promising something that isn't in this release.
      if (p && mine.length === 0 && s !== "Active" && s !== "Overdue")
        return s === "Settled"
          ? { tone: "done", title: `Nothing in this release was for you, ${first}.`, body: `${name}'s release has completed. None of its transfers went to you. If anything is left in the plan, a follow-up round can still include you.` }
          : { tone: "calm", title: `This release has nothing for you, ${first}.`, body: `None of the transfers in ${name}'s release #${p.id} go to you. There's nothing to receive this time; if anything is left afterwards, a follow-up round can include you.` };
      if (s === "Proposed") return { tone: "calm", title: `Nothing for you to do yet, ${first}.`, body: `${name}'s guardians have proposed a release. Nothing moves until enough of them approve and a waiting period passes.` };
      if (s === "Waiting" && ends)
        return {
          tone: "calm",
          title: `Nothing for you to do yet, ${first}.`,
          body: `In about ${relative(ends, ctx.now).replace("in ", "")} you'll be able to receive what ${name} set aside for you. If ${name} turns out to be reachable, they can stop this until then. That's by design.`,
          deadline: { at: ends, label: "Ready in" },
        };
      if (s === "Eligible" || (s === "Executing" && !started))
        return { tone: "attention", title: `It's ready for you, ${first}.`, body: `You can now receive what ${name} set aside for you. It goes straight to the addresses ${name} chose; network fees are already covered.` };
      if (s === "Executing") return { tone: "calm", title: "On its way.", body: "Each part arrives separately. You can close this page; nothing is lost if you do." };
      if (s === "Settled") return { tone: "done", title: "Done.", body: `Everything ${name} set aside for you has arrived. Your receipts are below.` };
      return {
        tone: "calm",
        title: `Nothing for you to do yet, ${first}.`,
        body: `${name} has set something aside for you. If ${name} stops checking in, their guardians can start a release and we'll walk you through receiving it.`,
      };
    }

    case "delay": {
      const open = s === "Waiting" && ends != null && ctx.now < ends;
      if (open && ctx.delay?.pending && !ctx.delay.voted)
        return { tone: "attention", title: "An extension needs your vote.", body: "Another delay signer asked for more time before heirs can receive. Agree if you think the owner may still be reachable.", deadline: { at: ends!, label: "Waiting period ends in" } };
      if (open && ctx.delay?.pending) return { tone: "calm", title: "You agreed to the extension.", body: "It applies once enough delay signers agree.", deadline: { at: ends!, label: "Waiting period ends in" } };
      if (open && ctx.delay?.capLeft !== false)
        return { tone: "calm", title: "You can ask for more time.", body: `If you think ${name} may still be reachable, request a longer waiting period. You can't approve, cancel or move anything.`, deadline: { at: ends!, label: "Waiting period ends in" } };
      return { tone: "calm", title: "Nothing for you to do yet.", body: "Delay signers can only act while an approved release is in its waiting period." };
    }

    default:
      return { tone: s === "Settled" ? "done" : s === "Active" ? "calm" : "attention", title: STATUS_STYLE[s].label, body: "Everything here is read straight from the chain. Nobody can change where funds go." };
  }
}
