import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { STATUS_STYLE, TRANSFER_STYLE, type Actions } from "@/lib/plan";
import type { PlanStatus, TransferState } from "@/lib/types";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "ink" | "mint" | "outline" | "outline-light" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  ink: "bg-ink text-paper hover:bg-panel",
  mint: "bg-mint text-ink hover:brightness-95",
  outline: "border-[1.5px] border-ink text-ink hover:bg-ink hover:text-paper",
  "outline-light": "border-[1.5px] border-line-dark text-paper hover:border-mint",
  ghost: "text-ink underline-offset-4 hover:underline",
  danger: "bg-s-failed text-ink hover:brightness-95",
};
const base = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 font-semibold transition-[background,color,filter,border] duration-[120ms] ease-ledger disabled:cursor-not-allowed disabled:opacity-50";

export function Button({ variant = "ink", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(base, VARIANTS[variant], className)} {...p} />;
}

export function ButtonLink({ variant = "ink", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(base, VARIANTS[variant], className)} {...p} />;
}

export function Card({ dark, className, ...p }: ComponentProps<"section"> & { dark?: boolean }) {
  return <section className={cx("rounded-card p-5 sm:p-6", dark ? "void bg-void text-paper" : "border-[1.5px] border-ink bg-card", className)} {...p} />;
}

/** "[ Label ]" section marker from the design system. */
export function Bracket({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return <span className={cx("font-mono text-xs font-bold uppercase tracking-wide", dark ? "text-muted-dark" : "text-ink")}>[ {children} ]</span>;
}

export function TestnetTag() {
  return <span className="rounded-tag bg-ink px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-testnet">TESTNET</span>;
}

export function StatusPill({ status, plain }: { status: PlanStatus; plain?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-bold text-ink", !plain && "font-mono uppercase")} style={{ background: s.color }}>
      <span aria-hidden="true">{s.sym}</span>
      {s.label}
    </span>
  );
}

export function TransferPill({ state, plain }: { state: TransferState; plain?: boolean }) {
  const s = TRANSFER_STYLE[state];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold text-ink", !plain && "font-mono uppercase")} style={{ background: s.color }}>
      <span aria-hidden="true">{s.sym}</span>
      {s.label}
    </span>
  );
}

/** "Can act now / Can't" rows on status cards. */
export function CanAct({ actions, plain }: { actions: Actions; plain?: boolean }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <div className="flex flex-col gap-1 rounded-2xl bg-mint p-3.5 text-ink">
        <span className={cx("text-[11px] font-bold", !plain && "font-mono")}>{plain ? "You can" : "CAN ACT NOW"}</span>
        <span className="text-sm">{actions.can.length ? actions.can.join(" · ") : "Nothing right now."}</span>
      </div>
      <div className="flex flex-col gap-1 rounded-2xl bg-ink p-3.5 text-paper">
        <span className={cx("text-[11px] font-bold text-[#FF8A80]", !plain && "font-mono")}>{plain ? "You can't" : "CAN'T"}</span>
        <span className="text-sm">{actions.cant.length ? actions.cant.join(" · ") : "Nothing is blocked."}</span>
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs font-semibold text-[#B3261E]">{error}</span>}
    </label>
  );
}

export const inputClass = "min-h-12 w-full rounded-tile border-[1.5px] border-ink bg-card px-3.5 text-base placeholder:text-muted focus:border-mint focus:outline-none";

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  const t = { info: "border-ink bg-card", ok: "border-mint-ink bg-[#E6FBF3]", error: "border-[#B3261E] bg-[#FFF1EF]" }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-tile border-[1.5px] px-4 py-3 text-sm", t)}>
      {children}
    </div>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cx("underline decoration-1 underline-offset-4 hover:text-mint-ink", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export { cx };
