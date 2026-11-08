import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { STATUS_STYLE, TRANSFER_STYLE, type Actions, type ChipStyle } from "@/lib/plan";
import type { PlanStatus, TransferState } from "@/lib/types";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// Buttons: 48px, 12px corners. "primary" is the blue call to action, "ink"
// the dark default, "outline" a bordered neutral, "subtle" the grey
// secondary, "danger" the soft red, "outline-light" for dark surfaces.
// ("mint" is kept as an alias of primary for older call sites.)
type Variant = "primary" | "ink" | "mint" | "outline" | "outline-light" | "subtle" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-[#1D4ED8]",
  mint: "bg-primary text-white hover:bg-[#1D4ED8]",
  ink: "bg-ink text-ink-contrast hover:opacity-90",
  outline: "border border-line-strong bg-card text-ink hover:bg-subtle",
  "outline-light": "border border-white/20 text-white hover:bg-white/10",
  subtle: "bg-subtle text-ink hover:bg-line",
  ghost: "text-ink underline-offset-4 hover:underline",
  danger: "bg-error-bg text-error hover:opacity-90",
};
const base =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-tile px-5 text-[15px] font-medium tracking-[-0.01em] transition-[background,color,opacity,border] duration-[120ms] ease-ledger disabled:cursor-not-allowed disabled:opacity-50";

export function Button({ variant = "ink", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(base, VARIANTS[variant], className)} {...p} />;
}

export function ButtonLink({ variant = "ink", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(base, VARIANTS[variant], className)} {...p} />;
}

/** Outlined card (24px). `dark` is the fixed dark surface used for the pulse. */
export function Card({ dark, className, ...p }: ComponentProps<"section"> & { dark?: boolean }) {
  return <section className={cx("rounded-card p-5 sm:p-6", dark ? "bg-void text-white" : "border border-line bg-card", className)} {...p} />;
}

/** Section label ("Balances", "Lifecycle"). */
export function Bracket({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return <span className={cx("text-sm font-semibold", dark ? "text-muted-dark" : "text-ink")}>{children}</span>;
}

export function TestnetTag() {
  return <span className="inline-flex h-6 items-center rounded-tag bg-s-approved px-2 text-xs font-semibold text-[var(--s-approved-fg)]">Testnet</span>;
}

/** Tinted 6px chip with a dot whose shape differs per state (readable without colour). */
export function Chip({ style, children, className }: { style: ChipStyle; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx("inline-flex h-7 shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-tag px-2.5 text-sm font-semibold", className)}
      style={{ background: `var(--s-${style.tone}-bg)`, color: `var(--s-${style.tone}-fg)` }}
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-current" style={{ borderRadius: style.shape === "circle" ? "50%" : style.shape === "square" ? "2px" : "1px", transform: style.shape === "diamond" ? "rotate(45deg)" : undefined }} />
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: PlanStatus; plain?: boolean }) {
  const s = STATUS_STYLE[status];
  return <Chip style={s}>{s.label}</Chip>;
}

export function TransferPill({ state }: { state: TransferState; plain?: boolean }) {
  const s = TRANSFER_STYLE[state];
  return <Chip style={s}>{s.label}</Chip>;
}

/** "You can / You can't" rows on status cards. */
export function CanAct({ actions, plain }: { actions: Actions; plain?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="flex flex-col gap-1 rounded-row bg-ok-bg p-4 text-ok">
        <span className="text-[13px] font-semibold">{plain ? "You can" : "Can act now"}</span>
        <span className="text-sm text-ink">{actions.can.length ? actions.can.join(" · ") : "Nothing right now."}</span>
      </div>
      <div className="flex flex-col gap-1 rounded-row bg-subtle p-4">
        <span className="text-[13px] font-semibold text-muted">{plain ? "You can't" : "Can't"}</span>
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
      {hint && !error && <span className="text-[13px] text-muted">{hint}</span>}
      {error && <span className="text-[13px] font-semibold text-error">{error}</span>}
    </label>
  );
}

export const inputClass =
  "min-h-12 w-full rounded-tile border border-line-strong bg-card px-3.5 text-base text-ink placeholder:text-muted focus:border-signal focus:outline-none focus:ring-1 focus:ring-signal";

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  const t = { info: "bg-subtle text-ink", ok: "bg-ok-bg text-ok", error: "bg-error-bg text-error" }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-row px-4 py-3 text-sm", t)}>
      {children}
    </div>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cx("text-signal-text underline decoration-1 underline-offset-4 hover:opacity-80", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export { cx };

const ASSET_MARK: Record<string, string> = { NEAR: "#171717", ETH: "#6366F1", BTC: "#FB7A1E" };

/** Asset heading: coloured ticker disc + name (design "Balances" rows). */
export function AssetHead({ ticker, name }: { ticker: "NEAR" | "ETH" | "BTC"; name: string }) {
  return (
    <span className="flex items-center gap-3">
      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold text-white ring-1 ring-white/10" style={{ background: ASSET_MARK[ticker] }}>
        {ticker}
      </span>
      <span className="text-[15px]">{name}</span>
    </span>
  );
}
