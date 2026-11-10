"use client";
// Shared pieces of the plan screen: the context every role view gets, the
// header with the role switch, the "what to do now" card and the proposal panel.
import Link from "next/link";
import { ChevronLeft, CircleCheck, Eye, Gift, Hourglass, KeyRound, Link2, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert, Vote, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NEAR_EXPLORER } from "@/lib/config";
import { ROLE_LABEL, type NextStep, type UiRole } from "@/lib/guide";
import { duration, relative, shortName, when } from "@/lib/plan";
import type { PlanView, Proposal, ReleaseRules } from "@/lib/types";
import { useConfirm } from "../feedback";
import { Address, Countdown, Segmented } from "../interactive";
import { ApprovalMeter, Avatar, TransferTable } from "../PlanParts";
import type { OptionsState } from "../ReleaseOptions";
import { SnapshotCheck } from "../Rounds";
import type { Act } from "../tx";
import { Button, Card, Notice, SectionTitle, StatusPill, cx } from "../ui";

/** Everything a role view needs, loaded once by the plan screen. */
export interface PlanCtx {
  view: PlanView;
  now: number;
  me: string | null;
  refresh: () => Promise<void>;
  rules: { rules: ReleaseRules | null | undefined; reload: () => Promise<void> };
  history: Proposal[] | null;
  followUp: boolean;
  options: OptionsState;
}

export const ROLE_ICON: Record<UiRole, LucideIcon> = { owner: KeyRound, guardian: ShieldCheck, heir: Gift, delay: Hourglass, public: Eye };

export function PlanHeader({ view, role, roles, onRole, actions }: { view: PlanView; role: UiRole; roles: UiRole[]; onRole: (r: UiRole) => void; actions?: ReactNode }) {
  const owner = view.plan.owner;
  const mine = role === "owner";
  const [copied, setCopied] = useState(false);
  return (
    <header className="flex flex-col gap-4">
      <Link href="/app" className="-ml-1 inline-flex min-h-9 items-center gap-1 self-start rounded-tile pr-2 text-sm text-muted hover:text-ink">
        <ChevronLeft aria-hidden className="size-4" />
        Home
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="hidden sm:block">
            <Avatar name={owner} i={0} size={52} />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="text-[clamp(28px,4.4vw,44px)] font-medium leading-none tracking-[-0.04em]">{mine ? "Your plan" : role === "public" ? "Plan inspector" : `${shortName(owner)}'s plan`}</h1>
              <StatusPill status={view.status} />
            </div>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted">
              <Address value={owner} href={`${NEAR_EXPLORER}/address/${owner}`} label="owner account" className="max-w-[260px]" />
              <span className="hidden sm:inline" aria-hidden>
                ·
              </span>
              <span className="hidden sm:inline">version {view.plan.version}</span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions}
          <Button
            variant="outline"
            size="sm"
            icon={copied ? CircleCheck : Link2}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${location.origin}/plan/${encodeURIComponent(owner)}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {}
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </Button>
        </div>
      </div>
      {roles.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm text-muted">Viewing as</span>
          <Segmented label="Viewing as" size="sm" value={role} onChange={onRole} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r], icon: ROLE_ICON[r] }))} />
        </div>
      )}
    </header>
  );
}

const TONE = {
  calm: { ring: "border-line", icon: Sparkles, tile: "bg-subtle text-ink" },
  attention: { ring: "border-signal/60 shadow-[0_0_0_3px_color-mix(in_srgb,var(--signal)_12%,transparent)]", icon: TriangleAlert, tile: "bg-s-approved text-[var(--s-approved-fg)]" },
  urgent: { ring: "border-[var(--s-overdue-fg)]/40", icon: TriangleAlert, tile: "bg-warn-bg text-warn" },
  done: { ring: "border-line", icon: CircleCheck, tile: "bg-ok-bg text-ok" },
} as const;

/** The first thing on every role view: the one thing to know or do now. */
export function NowCard({ step, now, role, children, className }: { step: NextStep; now: number; role: UiRole; children?: ReactNode; className?: string }) {
  const t = TONE[step.tone];
  const I = t.icon;
  const urgentDeadline = step.tone === "urgent" && step.deadline && step.deadline.at > now;
  return (
    <section aria-labelledby="now-title" className={cx("relative min-w-0 overflow-hidden rounded-card border bg-card", t.ring, className)}>
      {urgentDeadline && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-warn-bg px-5 py-3 text-warn sm:px-6">
          <span className="text-sm font-semibold">Cancel until {when(step.deadline!.at)}</span>
          <Countdown to={step.deadline!.at} now={now} className="text-sm font-semibold" prefix="" />
        </div>
      )}
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className={cx("flex size-8 items-center justify-center rounded-full", t.tile)}>
            <I className="size-4" />
          </span>
          <span className="text-sm font-semibold text-muted">{role === "public" ? "Where it stands" : "What to do now"}</span>
        </div>
        <div className="flex flex-col gap-2">
          <h2 id="now-title" key={step.title} className="animate-fade-up text-[clamp(26px,3.6vw,36px)] font-medium leading-[1.05] tracking-[-0.035em]">
            {step.title}
          </h2>
          <p className="max-w-[680px] text-[17px] leading-relaxed text-muted">{step.body}</p>
        </div>
        {step.deadline && !urgentDeadline && step.deadline.at > now && (
          <div className="inline-flex flex-wrap items-center gap-2 self-start rounded-tile bg-subtle px-3 py-2 text-sm">
            <Hourglass aria-hidden className="size-4 text-muted" />
            <span className="text-muted">{step.deadline.label}</span>
            <Countdown to={step.deadline.at} now={now} className="font-semibold" />
          </div>
        )}
        {children && <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{children}</div>}
      </div>
    </section>
  );
}

/** The open proposal: approvals, transfers, the numbers check and (for guardians who haven't voted) the vote. */
export function ProposalPanel({ view, now, me, act, busy, vote, technical }: { view: PlanView; now: number; me: string | null; act?: Act; busy?: boolean; vote?: boolean; technical?: boolean }) {
  const confirm = useConfirm();
  const p = view.plan.proposal;
  if (!p) return null;
  const s = view.status;
  const name = shortName(view.plan.owner);
  const canVote = vote && s === "Proposed" && !!me && !p.approvals.includes(me) && !p.rejections.includes(me);
  return (
    <Card id="proposal" className="flex scroll-mt-24 flex-col gap-5">
      <SectionTitle
        icon={Vote}
        title={`Proposal #${p.id}`}
        sub={`Proposed by ${shortName(p.proposer)} ${relative(p.created_at_ms, now)} · ${p.transfers.length} transfer${p.transfers.length === 1 ? "" : "s"}`}
        aside={<StatusPill status={s} />}
      />
      <ApprovalMeter view={view} />
      <TransferTable transfers={p.transfers} technical={technical} />
      {vote && (s === "Proposed" || s === "Waiting") && <SnapshotCheck view={view} />}
      {canVote && act && (
        <div className="flex flex-col gap-2 rounded-row bg-subtle p-4 sm:flex-row sm:items-center">
          <span className="flex-1 text-sm">You approve or reject this exact proposal; nobody can change what it pays out.</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="danger"
              icon={ThumbsDown}
              disabled={busy}
              onClick={async () => {
                if (await confirm({ title: `Reject proposal #${p.id}?`, body: `Your rejection is recorded on-chain. If enough guardians reject, the release won't go ahead and ${name}'s plan is unfrozen.`, tone: "danger", confirmLabel: "Reject" }))
                  await act("Reject", "reject_release", { owner: view.plan.owner, proposal_id: p.id }, { tgas: 100, done: "Rejection recorded." });
              }}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              icon={ThumbsUp}
              loading={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Approve proposal #${p.id}?`,
                    body: `If ${view.plan.policy.quorum} guardians approve, a waiting period starts. ${name} can still cancel until it ends.`,
                    rows: [
                      ["Approvals after yours", `${p.approvals.length + 1} of ${view.plan.policy.quorum}`],
                      ["Waiting period", duration(view.plan.policy.waiting_period_ms)],
                    ],
                    acknowledge: "I've checked the numbers above.",
                    confirmLabel: "Approve",
                  })
                )
                  await act("Approve", "approve_release", { owner: view.plan.owner, proposal_id: p.id }, { tgas: 100, done: "Approval recorded." });
              }}
            >
              Approve this exact proposal
            </Button>
          </div>
        </div>
      )}
      {s === "Waiting" && p.waiting_ends_at_ms && (
        <Notice title="Approved">
          {name} can cancel until {when(p.waiting_ends_at_ms)} (<Countdown to={p.waiting_ends_at_ms} now={now} prefix="in " />
          ). Then the heirs can receive.
        </Notice>
      )}
      {technical && (
        <span className="font-mono text-xs leading-relaxed text-muted">
          plan version {p.plan_version} · created {when(p.created_at_ms)} · gas limit {p.eth_gas_limit.toLocaleString()}
        </span>
      )}
    </Card>
  );
}

/** A labelled group of sections. */
export function Group({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section aria-label={title} id={id} className="flex scroll-mt-24 flex-col gap-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <h2 className="text-sm font-semibold text-muted">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

