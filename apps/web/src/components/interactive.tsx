"use client";
// Interactive primitives: fields, copy, addresses, jargon tooltips, dialogs,
// sheets, disclosures, segmented controls and live countdowns.
import { Check, ChevronDown, CircleHelp, Copy, ExternalLink, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";
import { countdown } from "@/lib/guide";
import { shortAddr } from "@/lib/plan";
import { cx } from "./ui";

// ------------------------------------------------------------------ fields

export interface ControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * Label, control, hint and error. Pass a function child to get the ids that
 * tie the label, hint and error to the control; a plain child is wrapped in
 * the label instead.
 */
export function Field({
  label,
  hint,
  error,
  tip,
  optional,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | false;
  tip?: GlossaryKey;
  optional?: boolean;
  children: ReactNode | ((p: ControlProps) => ReactNode);
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint && !error ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  const head = (
    <span className="flex items-center gap-1.5 text-sm font-semibold">
      {label}
      {optional && <span className="font-medium text-muted">(optional)</span>}
    </span>
  );
  const foot = (
    <>
      {hint && !error && (
        <span id={hintId} className="text-[13px] leading-snug text-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} className="flex animate-fade-in items-start gap-1 text-[13px] font-semibold leading-snug text-error">
          {error}
        </span>
      )}
    </>
  );
  if (typeof children === "function") {
    return (
      <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
        <div className="flex items-center gap-1">
          <label htmlFor={id}>{head}</label>
          {tip && <Tip k={tip} />}
        </div>
        {children({ id, "aria-describedby": described, "aria-invalid": error ? true : undefined })}
        {foot}
      </div>
    );
  }
  return (
    <label className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      {head}
      {children}
      {foot}
    </label>
  );
}

// ------------------------------------------------------------ copy & links

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  }
}

export function CopyButton({ value, label = "Copy", className, dark }: { value: string; label?: string; className?: string; dark?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (await writeClipboard(value)) setDone(true);
      }}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      className={cx(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-[120ms] after:absolute after:-inset-1.5 after:content-['']",
        dark ? "text-[#A1A1A1] hover:bg-white/10 hover:text-white" : "text-muted hover:bg-subtle hover:text-ink",
        done && "text-ok",
        className,
      )}
    >
      {done ? <Check aria-hidden className="size-4 animate-pop" /> : <Copy aria-hidden className="size-4" />}
      <span className="sr-only" aria-live="polite">
        {done ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}

/** An address or hash: mono, shortened if asked, with copy and an explorer link. */
export function Address({ value, href, short, className, dark, label }: { value: string; href?: string | null; short?: boolean; className?: string; dark?: boolean; label?: string }) {
  return (
    <span className={cx("inline-flex min-w-0 max-w-full items-center gap-0.5", className)}>
      <span className={cx("min-w-0 font-mono text-[13px]", short ? "whitespace-nowrap" : "truncate")} title={value}>
        {short ? shortAddr(value) : value}
      </span>
      <CopyButton value={value} label={`Copy ${label ?? "address"}`} dark={dark} />
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${label ?? "address"} on the explorer (opens in a new tab)`}
          title="View on explorer"
          className={cx(
            "relative inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors after:absolute after:-inset-1.5 after:content-['']",
            dark ? "text-[#A1A1A1] hover:bg-white/10 hover:text-white" : "text-muted hover:bg-subtle hover:text-ink",
          )}
        >
          <ExternalLink aria-hidden className="size-4" />
        </a>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- tooltips

function usePopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const place = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
    const above = r.top > 180;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const close = () => setOpen(false);
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [open, place]);
  return { open, setOpen, anchor, pos };
}

/**
 * Rendered into the page body (or the open dialog, which sits in the top
 * layer), never next to the anchor: an ancestor with a transform, filter or
 * will-change would otherwise become the box that `fixed` is measured from,
 * and the bubble would land far from the icon.
 */
function Bubble({ id, pos, anchor, children }: { id: string; pos: { left: number; top: number; above: boolean }; anchor: HTMLElement | null; children: ReactNode }) {
  const host = anchor?.closest("dialog[open]") ?? document.body;
  return createPortal(
    <span
      role="tooltip"
      id={id}
      className="pointer-events-none fixed z-[70] w-[min(300px,calc(100vw-24px))] animate-fade-in rounded-tile bg-toast px-3.5 py-2.5 text-left text-[13px] font-medium leading-snug text-toast-fg shadow-float"
      style={{ left: pos.left, top: pos.top, transform: pos.above ? "translateY(-100%)" : undefined }}
    >
      {children}
    </span>,
    host,
  );
}

/** A jargon word with a dotted underline; hover, focus or tap explains it. */
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  const id = useId();
  const { open, setOpen, anchor, pos } = usePopover();
  return (
    <>
      <button
        type="button"
        ref={(el) => void (anchor.current = el)}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help underline decoration-muted decoration-dotted decoration-1 underline-offset-[5px] hover:decoration-ink"
      >
        {children}
      </button>
      {open && pos && (
        <Bubble id={id} pos={pos} anchor={anchor.current}>
          {GLOSSARY[k]}
        </Bubble>
      )}
    </>
  );
}

/** A small help icon that explains a term. */
export function Tip({ k, text, label = "What does this mean?", dark }: { k?: GlossaryKey; text?: ReactNode; label?: string; dark?: boolean }) {
  const id = useId();
  const { open, setOpen, anchor, pos } = usePopover();
  return (
    <>
      <button
        type="button"
        ref={(el) => void (anchor.current = el)}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={cx("relative inline-flex size-6 shrink-0 items-center justify-center rounded-full after:absolute after:-inset-2.5 after:content-['']", dark ? "text-[#A1A1A1] hover:text-white" : "text-muted hover:text-ink")}
      >
        <CircleHelp aria-hidden className="size-4" />
      </button>
      {open && pos && (
        <Bubble id={id} pos={pos} anchor={anchor.current}>
          {text ?? (k ? GLOSSARY[k] : null)}
        </Bubble>
      )}
    </>
  );
}

// ----------------------------------------------------------------- dialogs

/**
 * Native modal dialog: focus trap, Escape and backdrop close, fade-in. `sheet`
 * slides in from the right (or bottom on phones when `bottom` is set).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  sheet,
  bottom,
  size = "md",
  dark,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  sheet?: boolean;
  bottom?: boolean;
  size?: "sm" | "md" | "lg";
  dark?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const width = { sm: "sm:w-[min(440px,calc(100vw-32px))]", md: "sm:w-[min(520px,calc(100vw-32px))]", lg: "sm:w-[min(680px,calc(100vw-32px))]" }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={cx(
        "behest-dialog max-h-[calc(100dvh-24px)] overflow-hidden p-0 shadow-float",
        dark ? "bg-[#0A0A0A] text-[#FAFAFA]" : "border border-line bg-paper text-ink",
        sheet
          ? cx(
              "behest-sheet m-0 ml-auto h-dvh max-h-dvh w-[min(420px,100vw)] rounded-none rounded-l-card",
              bottom && "from-bottom mt-auto h-auto max-h-[88dvh] w-full max-w-none rounded-l-none rounded-t-card sm:ml-auto sm:mt-0 sm:h-dvh sm:max-h-dvh sm:w-[min(420px,100vw)] sm:rounded-none sm:rounded-l-card",
            )
          : cx("m-auto w-[calc(100vw-24px)] rounded-card", width),
      )}
    >
      <div className={cx("flex max-h-[inherit] flex-col", sheet && "h-full")}>
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5 sm:px-6 sm:pt-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-[26px] font-medium leading-tight tracking-[-0.03em]">
              {title}
            </h2>
            {description && (
              <p id={descId} className={cx("text-sm leading-relaxed", dark ? "text-[#A1A1A1]" : "text-muted")}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cx("-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-full", dark ? "text-[#A1A1A1] hover:bg-white/10" : "text-muted hover:bg-subtle hover:text-ink")}
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5 pt-2 sm:px-6 sm:pb-6">{children}</div>
        {footer && <div className={cx("flex flex-wrap justify-end gap-2 border-t px-5 py-4 sm:px-6", dark ? "border-white/10" : "border-line")}>{footer}</div>}
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------- disclosure

/** A section that opens and closes with a height animation. Content stays mounted (and inert while closed). */
export function Disclosure({
  title,
  sub,
  icon: I,
  aside,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  children,
  id,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  aside?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const bodyId = useId();
  const toggle = () => {
    setOwn(!open);
    onOpenChange?.(!open);
  };
  return (
    <section id={id} className={cx("min-w-0 scroll-mt-24 rounded-card border border-line bg-card", className)}>
      <div className="flex items-center gap-2 pr-3">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle} className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-card px-5 py-3 text-left sm:px-6">
          {I && (
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-tile bg-subtle">
              <I className="size-[18px]" />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[17px] font-semibold leading-tight tracking-[-0.01em]">{title}</span>
            {sub && <span className="truncate text-sm text-muted">{sub}</span>}
          </span>
          <ChevronDown aria-hidden className={cx("size-5 shrink-0 text-muted transition-transform duration-300 ease-ledger", open && "rotate-180")} />
        </button>
        {aside}
      </div>
      <div id={bodyId} className="disclosure-body" data-open={open} inert={!open}>
        <div>
          <div className="flex flex-col gap-4 border-t border-line px-5 pb-5 pt-4 sm:px-6 sm:pb-6">{children}</div>
        </div>
      </div>
    </section>
  );
}

// -------------------------------------------------------------- segmented

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
}

/** A row of mutually exclusive choices (radio group), arrow-key navigable. */
export function Segmented<T extends string>({ options, value, onChange, label, className, size = "md" }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string; size?: "sm" | "md" }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex max-w-full gap-1 overflow-x-auto rounded-tile bg-subtle p-1", className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        const I = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(o.value)}
            className={cx(
              "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-[background,color,box-shadow] duration-200 ease-ledger",
              size === "sm" ? "min-h-9 px-3 text-sm" : "min-h-10 px-3.5 text-[15px]",
              on ? "bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_1px_var(--line)]" : "text-muted hover:text-ink",
            )}
          >
            {I && <I aria-hidden className="size-4" />}
            {o.label}
            {o.badge}
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- countdown

/** Live time-left text, ticking with the chain clock passed in as `now`. */
export function Countdown({ to, now, className, prefix }: { to: number; now: number; className?: string; prefix?: string }) {
  const left = to - now;
  return (
    <span role="timer" className={cx("tabular font-mono", className)} title={new Date(to).toLocaleString()}>
      {prefix}
      {countdown(left)}
    </span>
  );
}

/** Ticks once a second; for pages without a chain clock. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
