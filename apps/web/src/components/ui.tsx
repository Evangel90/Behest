// Presentational primitives (no hooks), safe in server and client components.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { MoreText } from "./more";
import { STATUS_STYLE, TRANSFER_STYLE, type Actions, type ChipStyle } from "@/lib/plan";
import type { PlanStatus, TransferState } from "@/lib/types";
import { BehestLoader, type LoaderTone } from "./BehestLoader";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// Buttons: 48px (52 large, 44 small), 12px corners. "primary" is the blue
// call to action, "ink" the dark default, "outline" a bordered neutral,
// "subtle" the grey secondary, "danger" the soft red, "outline-light" for
// dark surfaces. ("mint" is kept as an alias of primary for older call sites.)
type Variant = "primary" | "ink" | "night" | "mint" | "outline" | "outline-light" | "subtle" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover active:bg-primary-hover",
  mint: "bg-primary text-white hover:bg-primary-hover active:bg-primary-hover",
  ink: "bg-ink text-ink-contrast hover:opacity-90",
  // Always dark, for light backgrounds that don't change with the theme (the blue CTA band).
  night: "bg-[#0A0A0A] text-white hover:bg-black",
  outline: "border border-line-strong bg-card text-ink hover:bg-subtle",
  "outline-light": "border border-white/20 text-white hover:bg-white/10",
  subtle: "bg-subtle text-ink hover:bg-line",
  ghost: "text-ink hover:bg-subtle",
  danger: "bg-error-bg text-error hover:opacity-90",
};
const SIZES: Record<Size, string> = {
  sm: "min-h-11 px-3.5 text-sm",
  md: "min-h-12 px-5 text-[15px]",
  lg: "min-h-[52px] px-6 text-base",
};
const base =
  "relative inline-flex select-none items-center justify-center gap-2 rounded-tile font-medium tracking-[-0.01em] transition-[background,color,opacity,border,transform] duration-[120ms] ease-ledger active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";

interface BtnExtra {
  variant?: Variant;
  size?: Size;
  /** Lucide icon shown before the label (replaced by a spinner while loading). */
  icon?: LucideIcon;
  /** Lucide icon after the label. */
  iconRight?: LucideIcon;
  /** Pending: shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
}

const LOADER_TONE: Record<Variant, LoaderTone> = { primary: "dark", mint: "dark", night: "dark", "outline-light": "dark", ink: "inverse", outline: "theme", subtle: "theme", ghost: "theme", danger: "theme" };

function Inner({ icon: I, iconRight: R, loading, variant = "ink", children }: Pick<BtnExtra, "icon" | "iconRight" | "loading" | "variant"> & { children?: ReactNode }) {
  return (
    <>
      {loading ? <BehestLoader size={20} label="Working" tone={LOADER_TONE[variant]} /> : I && <I aria-hidden className="size-[18px] shrink-0" strokeWidth={2} />}
      {children}
      {R && !loading && <R aria-hidden className="size-[18px] shrink-0" strokeWidth={2} />}
    </>
  );
}

export function Button({ variant = "ink", size = "md", icon, iconRight, loading, className, children, disabled, ...p }: ComponentProps<"button"> & BtnExtra) {
  return (
    <button className={cx(base, SIZES[size], VARIANTS[variant], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...p}>
      <Inner icon={icon} iconRight={iconRight} loading={loading} variant={variant}>
        {children}
      </Inner>
    </button>
  );
}

export function ButtonLink({ variant = "ink", size = "md", icon, iconRight, className, children, ...p }: ComponentProps<typeof Link> & Omit<BtnExtra, "loading">) {
  return (
    <Link className={cx(base, SIZES[size], VARIANTS[variant], className)} {...p}>
      <Inner icon={icon} iconRight={iconRight}>
        {children}
      </Inner>
    </Link>
  );
}

/** Square icon-only button (44px touch target). Always pass `label`. */
export function IconButton({ icon: I, label, className, dark, ...p }: ComponentProps<"button"> & { icon: LucideIcon; label: string; dark?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-tile transition-colors duration-[120ms] disabled:opacity-50",
        dark ? "text-[#D4D4D4] hover:bg-white/10 hover:text-white" : "text-muted hover:bg-subtle hover:text-ink",
        className,
      )}
      {...p}
    >
      <I aria-hidden className="size-[18px]" />
    </button>
  );
}

/** Outlined card (24px). `dark` is the fixed dark surface used for the pulse. */
export function Card({ dark, className, ...p }: ComponentProps<"section"> & { dark?: boolean }) {
  return <section className={cx("min-w-0 rounded-card p-5 sm:p-6", dark ? "bg-void text-white" : "border border-line bg-card", className)} {...p} />;
}

/** Section label ("Balances", "Lifecycle"). */
export function Bracket({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return <span className={cx("text-sm font-semibold", dark ? "text-muted-dark" : "text-ink")}>{children}</span>;
}

/** Card heading row: icon tile, title, optional aside on the right. */
export function SectionTitle({ icon: I, title, aside, sub, as: H = "h2" }: { icon?: LucideIcon; title: ReactNode; aside?: ReactNode; sub?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-start gap-3">
        {I && (
          <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-tile bg-subtle text-ink">
            <I className="size-[18px]" />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <H className="text-[17px] font-semibold leading-tight tracking-[-0.01em]">{title}</H>
          {sub && <span className="text-sm text-muted">{typeof sub === "string" ? <MoreText text={sub} /> : sub}</span>}
        </div>
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}

export function TestnetTag() {
  return <span className="inline-flex h-6 shrink-0 items-center rounded-tag bg-s-approved px-2 text-xs font-semibold text-[var(--s-approved-fg)]">Testnet</span>;
}

/** Tinted 6px chip with a dot whose shape differs per state (readable without colour). `live` adds a soft ping. */
export function Chip({ style, children, className, live }: { style: ChipStyle | (Omit<ChipStyle, "tone"> & { tone: ChipStyle["tone"] | "extended" }); children: ReactNode; className?: string; live?: boolean }) {
  return (
    <span
      key={String(children)}
      className={cx("inline-flex h-7 shrink-0 animate-pop items-center gap-2 self-start whitespace-nowrap rounded-tag px-2.5 text-sm font-semibold", className)}
      style={{ background: `var(--s-${style.tone}-bg)`, color: `var(--s-${style.tone}-fg)` }}
    >
      <span aria-hidden="true" className="relative flex size-2 shrink-0">
        {live && <span className="absolute inset-0 animate-ping-soft rounded-full bg-current" />}
        <span
          className="relative size-2 bg-current"
          style={{ borderRadius: style.shape === "circle" ? "50%" : style.shape === "square" ? "2px" : "1px", transform: style.shape === "diamond" ? "rotate(45deg) scale(0.9)" : undefined }}
        />
      </span>
      {children}
    </span>
  );
}

const LIVE: PlanStatus[] = ["Proposed", "Waiting", "Executing"];

export function StatusPill({ status }: { status: PlanStatus; plain?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <Chip style={s} live={LIVE.includes(status)}>
      {s.label}
    </Chip>
  );
}

export function TransferPill({ state }: { state: TransferState; plain?: boolean }) {
  const s = TRANSFER_STYLE[state];
  return (
    <Chip style={s} live={state === "Sending" || state === "Signing" || state === "Broadcast"}>
      {s.label}
    </Chip>
  );
}

/** "You can / You can't" rows on status cards. */
export function CanAct({ actions, plain }: { actions: Actions; plain?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className={cx("flex flex-col gap-1 rounded-row p-4", actions.can.length ? "bg-ok-bg text-ok" : "bg-subtle text-muted")}>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <CircleCheck aria-hidden className="size-4" />
          {plain ? "You can" : "Can act now"}
        </span>
        <span className="text-sm text-ink">{actions.can.length ? actions.can.join(" · ") : "Nothing right now."}</span>
      </div>
      <div className="flex flex-col gap-1 rounded-row bg-subtle p-4">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
          <CircleAlert aria-hidden className="size-4" />
          {plain ? "You can't" : "Can't"}
        </span>
        <span className="text-sm">{actions.cant.length ? actions.cant.join(" · ") : "Nothing is blocked."}</span>
      </div>
    </div>
  );
}

export const inputClass =
  "min-h-12 w-full min-w-0 rounded-tile border border-line-strong bg-card px-3.5 text-base text-ink transition-[border,box-shadow] duration-[120ms] placeholder:text-muted hover:border-muted focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/25 aria-[invalid=true]:border-error aria-[invalid=true]:ring-error/20 disabled:opacity-60";

const NOTICE = {
  info: { cls: "bg-subtle text-ink", icon: Info },
  ok: { cls: "bg-ok-bg text-ok", icon: CircleCheck },
  warn: { cls: "bg-warn-bg text-warn", icon: TriangleAlert },
  error: { cls: "bg-error-bg text-error", icon: CircleAlert },
} as const;

export function Notice({ tone = "info", title, children, action, className }: { tone?: keyof typeof NOTICE; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const t = NOTICE[tone];
  const I = t.icon;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex animate-fade-up gap-3 rounded-row px-4 py-3 text-sm leading-relaxed", t.cls, className)}>
      <I aria-hidden className="mt-0.5 size-[18px] shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <span className="font-semibold">{title}</span>}
        {children && <div className="min-w-0 break-words">{children}</div>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

export function ExtLink({ href, children, className, icon = true }: { href: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-0.5 text-signal-text underline decoration-1 underline-offset-4 hover:opacity-80", className)}>
      {children}
      {icon && <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export { cx };

const ASSET_MARK: Record<string, string> = { NEAR: "#171717", ETH: "#6366F1", BTC: "#FB7A1E" };

/** Coloured ticker disc (design "Balances" rows). */
export function TickerDisc({ ticker, size = 32 }: { ticker: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-1 ring-white/10"
      style={{ background: ASSET_MARK[ticker] ?? "#3B82F6", width: size, height: size, fontSize: size < 28 ? Math.round(size * 0.45) : ticker.length > 3 ? Math.max(8, Math.round(size * 0.26)) : Math.round(size * 0.3) }}
    >
      {size < 28 ? ticker[0] : ticker}
    </span>
  );
}

/** Asset heading: coloured ticker disc + name. */
export function AssetHead({ ticker, name, sub }: { ticker: "NEAR" | "ETH" | "BTC"; name: string; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <TickerDisc ticker={ticker} />
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px] font-semibold">{name}</span>
        {sub && <span className="truncate text-[13px] text-muted">{sub}</span>}
      </span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block", className)} />;
}

/** A calm empty or error state with an icon, a line of explanation and actions. */
export function EmptyState({ icon: I, title, body, children, tone = "calm", className }: { icon: LucideIcon; title: ReactNode; body?: ReactNode; children?: ReactNode; tone?: "calm" | "error"; className?: string }) {
  return (
    <div className={cx("flex animate-fade-up flex-col items-center gap-3 rounded-card border border-dashed border-line-strong px-6 py-10 text-center", className)}>
      <span aria-hidden className={cx("flex size-12 items-center justify-center rounded-full", tone === "error" ? "bg-error-bg text-error" : "bg-subtle text-muted")}>
        <I className="size-6" />
      </span>
      <div className="flex max-w-[440px] flex-col gap-1">
        <span className="text-lg font-semibold tracking-[-0.01em]">{title}</span>
        {body && <span className="text-sm leading-relaxed text-muted">{body}</span>}
      </div>
      {children && <div className="flex flex-wrap justify-center gap-2 pt-1">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-subtle px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

/** Thin progress bar (transfer tracker). */
export function Progress({ value, tone = "signal", label }: { value: number; tone?: "signal" | "ok" | "error"; label?: string }) {
  const color = tone === "ok" ? "var(--s-active-fg)" : tone === "error" ? "var(--s-failed-fg)" : "var(--signal)";
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} className="block h-1.5 overflow-hidden rounded-full bg-line">
      <span className="block h-full rounded-full transition-[width] duration-700 ease-ledger" style={{ width: `${Math.max(4, value * 100)}%`, background: color }} />
    </span>
  );
}
