"use client";
import { Check, CircleCheck, Clock, Gift, HeartPulse, Hourglass, Send, Vote, type LucideIcon } from "lucide-react";
import { BTC_EXPLORER, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { countdown, timeline, TRANSFER_PROGRESS } from "@/lib/guide";
import { STATUS_STYLE, day, failureText, formatAmount, isBtc, isEvm, percent, shortAddr, shortName, when } from "@/lib/plan";
import type { PlanStatus, PlanView, Transfer } from "@/lib/types";
import { Address, CopyButton, Term } from "./interactive";
import { Chip, ExtLink, Progress, TickerDisc, TransferPill, cx } from "./ui";

/** Heir colours from the design's avatar set; the share bar uses the same order. */
const SHARE_COLORS = ["#2F6BFF", "#FB7A1E", "#6366F1", "#06B6D4", "#C026D3", "#16A34A", "#E11D48", "#A16207"];
const AVATAR_BG = ["#A9CCFF", "#FDBA8C", "#C7C8FA", "#A5F3FC", "#F5D0FE", "#BBF7D0", "#FECDD3", "#FDE68A"];

/** Bordered list card: a title strip over a white inset list (design "Balances"/"Heirs"). */
export function ListCard({ title, aside, children, className }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0 rounded-row border border-line bg-subtle px-1 pb-1", className)}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm font-semibold sm:px-5">
        <h2>{title}</h2>
        {aside && <span className="font-medium text-muted">{aside}</span>}
      </div>
      <div className="overflow-hidden rounded-tile border border-line bg-card">{children}</div>
    </section>
  );
}

export function Avatar({ name, i, size = 32 }: { name: string; i: number; size?: number }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-full text-sm font-semibold text-[#0A0A0A]" style={{ background: AVATAR_BG[i % AVATAR_BG.length], width: size, height: size }}>
      {(shortName(name)[0] ?? "?").toUpperCase()}
    </span>
  );
}

const STAGE_ICON: Record<PlanStatus, LucideIcon> = {
  Active: HeartPulse,
  Overdue: Clock,
  Proposed: Vote,
  Waiting: Hourglass,
  Eligible: Gift,
  Executing: Send,
  Settled: CircleCheck,
};

/**
 * The release lifecycle: done stages ticked, the current one highlighted with
 * its colour and a soft ping, upcoming ones hollow. Horizontal on wide
 * screens, vertical on phones. Known times and live countdowns underneath.
 */
export function Timeline({ view, now, compact }: { view: PlanView; now: number; compact?: boolean }) {
  const steps = timeline(view);
  return (
    <div className="@container min-w-0">
    <ol aria-label="Release lifecycle" className={cx("grid gap-0", compact ? "grid-cols-7" : "grid-cols-1 @[640px]:grid-cols-7")}>
      {steps.map((s, i) => {
        const I = STAGE_ICON[s.status];
        const fg = `var(--s-${STATUS_STYLE[s.status].tone}-fg)`;
        const bg = `var(--s-${STATUS_STYLE[s.status].tone}-bg)`;
        const future = s.at != null && s.at > now;
        return (
          <li
            key={s.status}
            aria-current={s.state === "current" ? "step" : undefined}
            className={cx("relative flex min-w-0 gap-3", compact ? "flex-col items-center" : "pb-5 last:pb-0 @[640px]:flex-col @[640px]:pb-0")}
          >
            {/* connector */}
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cx(
                  "absolute bg-line",
                  compact ? "left-1/2 right-[-50%] top-[13px] h-0.5" : "bottom-0 left-[17px] top-9 w-0.5 @[640px]:bottom-auto @[640px]:left-11 @[640px]:right-1 @[640px]:top-[17px] @[640px]:h-0.5 @[640px]:w-auto",
                )}
              >
                <span className="block h-full w-full origin-left bg-ink/70 transition-transform duration-700 ease-ledger" style={{ transform: s.state === "done" ? "scale(1)" : "scale(0)" }} />
              </span>
            )}
            <span
              className={cx("relative z-[1] flex shrink-0 items-center justify-center rounded-full transition-colors duration-500", compact ? "size-7" : "size-9")}
              style={s.state === "current" ? { background: bg, color: fg, boxShadow: `0 0 0 1.5px ${fg}` } : s.state === "done" ? { background: "var(--ink)", color: "var(--ink-contrast)" } : { background: "var(--card)", color: "var(--muted)", boxShadow: "inset 0 0 0 1.5px var(--line-strong)" }}
            >
              {s.state === "current" && <span aria-hidden className="absolute inset-0 animate-ping-soft rounded-full" style={{ background: fg, opacity: 0.25 }} />}
              {s.state === "done" ? <Check aria-hidden className={compact ? "size-3.5" : "size-4"} /> : <I aria-hidden className={compact ? "size-3.5" : "size-[18px]"} />}
            </span>
            {!compact && (
              <span className="flex min-w-0 flex-col gap-0.5 pt-1.5 @[640px]:pr-3 @[640px]:pt-0">
                <span className={cx("text-sm leading-tight", s.state === "current" ? "font-semibold text-ink" : s.state === "done" ? "text-ink" : "text-muted")}>{s.label}</span>
                {s.at != null && s.state !== "upcoming" && <span className="text-xs text-muted">{when(s.at)}</span>}
                {s.at != null && s.state === "upcoming" && future && (
                  <span className="tabular font-mono text-xs text-muted" role="timer">
                    in {countdown(s.at - now)}
                  </span>
                )}
                {s.state === "current" && <span className="text-xs leading-snug text-muted @[640px]:hidden">{s.detail}</span>}
              </span>
            )}
            {compact && <span className="sr-only">{s.label}</span>}
          </li>
        );
      })}
    </ol>
    </div>
  );
}

/** Older call sites: the compact lifecycle bar. */
export function Lifecycle({ status }: { status: PlanView["status"] }) {
  const v = { status, overdue_at_ms: 0, now_ms: 0, plan: { owner: "", version: 0, policy: { check_in_interval_ms: 0, grace_ms: 0, waiting_period_ms: 0, guardians: [], quorum: 0, heirs: [] }, last_check_in_ms: 0, escrow: "0", eth_next_nonce: 0, proposal: null, proposals_opened: 0 } } satisfies PlanView;
  return <Timeline view={v} now={0} compact />;
}

export function ShareBar({ heirs }: { heirs: { account_id: string; share_bps: number }[] }) {
  return (
    <div className="flex h-2.5 gap-[3px]" aria-hidden="true">
      {heirs
        .filter((h) => h.share_bps > 0)
        .map((h, i) => (
          <span key={h.account_id} className="rounded-tag transition-[width] duration-500 ease-ledger" style={{ width: `${h.share_bps / 100}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
        ))}
    </div>
  );
}

export function HeirList({ view, me }: { view: PlanView; me?: string | null }) {
  const heirs = view.plan.policy.heirs;
  return (
    <ListCard title={<Term k="heir">Heirs</Term>} aside={`${percent(heirs.reduce((a, h) => a + h.share_bps, 0))} allocated`}>
      <div className="px-4 pt-4 sm:px-5">
        <ShareBar heirs={heirs} />
      </div>
      <ul>
        {heirs.map((h, i) => (
          <li key={h.account_id} className={cx("flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5", i > 0 && "border-t border-line")}>
            <span className="flex min-w-0 items-center gap-3">
              <span className="relative">
                <Avatar name={h.account_id} i={i} />
                <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card" style={{ background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2 text-[15px]">
                  {shortName(h.account_id)}
                  {me === h.account_id && <span className="rounded-tag bg-s-approved px-1.5 text-xs font-semibold text-[var(--s-approved-fg)]">You</span>}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
                  {h.near_destination && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <TickerDisc ticker="NEAR" size={14} />
                      <Address value={h.near_destination} href={`${NEAR_EXPLORER}/address/${h.near_destination}`} className="[&>span:first-child]:max-w-[150px] [&>span:first-child]:text-xs" label={`${shortName(h.account_id)}'s NEAR destination`} />
                    </span>
                  )}
                  {h.eth_destination && (
                    <span className="inline-flex items-center gap-1">
                      <TickerDisc ticker="ETH" size={14} />
                      <Address value={h.eth_destination} short href={`${ETH_EXPLORER}/address/${h.eth_destination}`} className="[&>span:first-child]:text-xs" label={`${shortName(h.account_id)}'s Ethereum address`} />
                    </span>
                  )}
                </span>
              </span>
            </span>
            <span className="tabular shrink-0 text-[17px]">{percent(h.share_bps)}</span>
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

/** One dot per guardian: approved (filled), rejected (red) or not yet voted (dashed). */
export function ApprovalMeter({ view }: { view: PlanView }) {
  const p = view.plan.proposal;
  const { guardians, quorum } = view.plan.policy;
  const approvals = p?.approvals.length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex -space-x-1.5" aria-hidden>
        {guardians.map((g, i) => {
          const ok = p?.approvals.includes(g);
          const no = p?.rejections.includes(g);
          return (
            <span
              key={g}
              title={`${shortName(g)}: ${ok ? "approved" : no ? "rejected" : "not voted"}`}
              className={cx(
                "flex size-9 items-center justify-center rounded-full text-sm font-semibold ring-2 ring-card transition-colors duration-500",
                ok ? "bg-primary text-white" : no ? "bg-error-bg text-error" : "border border-dashed border-line-strong bg-card text-muted",
              )}
              style={{ zIndex: guardians.length - i }}
            >
              {(shortName(g)[0] ?? "?").toUpperCase()}
            </span>
          );
        })}
      </div>
      <span className="text-sm">
        <strong className="tabular font-semibold">
          {approvals} of {quorum}
        </strong>{" "}
        <span className="text-muted">approvals needed</span>
      </span>
    </div>
  );
}

export function GuardianList({ view, me }: { view: PlanView; me?: string | null }) {
  const p = view.plan.proposal;
  const { guardians, quorum } = view.plan.policy;
  return (
    <ListCard
      title={
        <>
          <Term k="guardian">Guardians</Term> · <Term k="quorum">any {quorum} of {guardians.length}</Term>
        </>
      }
      aside={p ? `${p.approvals.length} approved` : undefined}
    >
      <ul>
        {guardians.map((g, i) => {
          const approved = p?.approvals.includes(g);
          const rejected = p?.rejections.includes(g);
          return (
            <li key={g} className={cx("flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5", i > 0 && "border-t border-line")}>
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={g} i={i + 3} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-[15px]">
                    {shortName(g)}
                    {me === g && <span className="rounded-tag bg-s-approved px-1.5 text-xs font-semibold text-[var(--s-approved-fg)]">You</span>}
                  </span>
                  <Address value={g} href={`${NEAR_EXPLORER}/address/${g}`} className="text-muted [&>span:first-child]:text-xs" label={`${shortName(g)}'s account`} />
                </span>
              </span>
              {approved ? (
                <Chip style={{ tone: "active", shape: "circle", label: "" }}>Approved</Chip>
              ) : rejected ? (
                <Chip style={{ tone: "failed", shape: "diamond", label: "" }}>Rejected</Chip>
              ) : p ? (
                <Chip style={{ tone: "cancelled", shape: "square", label: "" }}>Not voted</Chip>
              ) : (
                <span className="text-sm text-muted">Standing by</span>
              )}
            </li>
          );
        })}
      </ul>
    </ListCard>
  );
}

export function receiptUrl(t: Transfer): string | null {
  if (isEvm(t.asset) && t.tx_hash) return `${ETH_EXPLORER}/tx/${t.tx_hash}`;
  if (isBtc(t.asset)) return t.tx_hash ? `${BTC_EXPLORER}/tx/${t.tx_hash}` : null;
  if (!isEvm(t.asset) && t.state === "Confirmed") return `${NEAR_EXPLORER}/address/${t.destination}`;
  return null;
}

const tickerOf = (t: Transfer) => (isBtc(t.asset) ? "BTC" : isEvm(t.asset) ? "ETH" : "NEAR");

/** Where a transfer goes: addresses shortened, NEAR accounts shown whole (CSS truncates). */
function Dest({ to }: { to: string }) {
  const addr = /^(0x|tb1|bc1)/i.test(to);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center">
      <span className="block min-w-0 truncate font-mono text-xs" title={to}>
        {addr ? shortAddr(to) : to}
      </span>
      <CopyButton value={to} label="Copy destination" />
    </span>
  );
}

function Receipt({ t }: { t: Transfer }) {
  const url = receiptUrl(t);
  if (!url) return <span className="text-muted">—</span>;
  return (
    <ExtLink href={url} className="font-mono text-xs">
      {t.tx_hash ? shortAddr(t.tx_hash) : "View"}
    </ExtLink>
  );
}

/**
 * Transfers as a table where there is room, and as stacked rows in narrow
 * containers (phones, the heir's column), so nothing scrolls sideways.
 */
export function TransferTable({ transfers, technical }: { transfers: Transfer[]; technical?: boolean }) {
  if (!transfers.length) return null;
  return (
    <div className="@container min-w-0">
      <ul className="divide-y divide-line rounded-tile border border-line @[680px]:hidden">
        {transfers.map((t, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5">
                <TickerDisc ticker={tickerOf(t)} size={28} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{formatAmount(t)}</span>
                  <span className="text-muted">to {shortName(t.heir)}</span>
                </span>
              </span>
              <TransferPill state={t.state} />
            </div>
            <Progress value={TRANSFER_PROGRESS[t.state]} tone={t.state === "Failed" ? "error" : t.state === "Confirmed" ? "ok" : "signal"} label={`${formatAmount(t)} progress`} />
            <div className="flex min-w-0 items-center justify-between gap-3 text-muted">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-xs">to</span>
                <Dest to={t.destination} />
              </span>
              <span className="shrink-0">
                <Receipt t={t} />
              </span>
            </div>
            {technical && t.eth_tx && <span className="font-mono text-xs text-muted">nonce {t.eth_tx.nonce} · gas {t.eth_tx.gas_limit.toLocaleString()}</span>}
            {t.failure && <span className="text-xs text-error">{failureText(t) || t.failure}</span>}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-tile border border-line @[680px]:block">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <thead>
            <tr className="bg-subtle text-[13px] text-muted">
              <th scope="col" className="w-[15%] px-4 py-3 font-medium">
                Heir
              </th>
              <th scope="col" className="w-[22%] px-4 py-3 font-medium">
                Amount
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                To
              </th>
              <th scope="col" className="w-[19%] px-4 py-3 font-medium">
                State
              </th>
              {technical && (
                <th scope="col" className="w-[13%] px-4 py-3 font-medium">
                  Nonce · gas
                </th>
              )}
              <th scope="col" className="w-[15%] px-4 py-3 font-medium">
                Receipt
              </th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t, i) => (
              <tr key={i} className="border-t border-line align-top transition-colors hover:bg-subtle/60">
                <td className="truncate px-4 py-3">{shortName(t.heir)}</td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <TickerDisc ticker={tickerOf(t)} size={20} />
                    <span className="min-w-0 break-words">{formatAmount(t)}</span>
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Dest to={t.destination} />
                </td>
                <td className="px-4 py-3">
                  <TransferPill state={t.state} />
                  {t.failure && (
                    <span className="mt-1 block text-xs text-error" title={failureText(t)}>
                      {t.failure}
                    </span>
                  )}
                </td>
                {technical && <td className="px-4 py-3 font-mono text-xs">{t.eth_tx ? `${t.eth_tx.nonce} · ${t.eth_tx.gas_limit.toLocaleString()}` : "—"}</td>}
                <td className="px-4 py-3">
                  <Receipt t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Row({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-t border-line py-2.5 text-sm first:border-t-0 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] sm:gap-3">
      <span className="text-muted">{k}</span>
      <span className={cx("min-w-0 break-words", mono && "break-all font-mono text-xs")}>{v}</span>
    </div>
  );
}

/** A completed release in one line (history lists). */
export function ReleaseSummary({ id, proposer, at, count }: { id: number; proposer: string; at: number; count: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-semibold">Release #{id}</span>
      <span className="text-sm text-muted">
        proposed by {shortName(proposer)} · {day(at)} · {count} transfer{count === 1 ? "" : "s"}
      </span>
    </span>
  );
}
