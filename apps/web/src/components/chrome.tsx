"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/lib/session";
import { Button, cx } from "./ui";
import { SignInDialog } from "./SignIn";

export function TestnetBar({ compact }: { compact?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap justify-center gap-x-2 bg-[#0A0A0A] px-4 py-2 text-center text-[13px] text-[#D4D4D4]">
      <span className="text-[#8DB4FF]">Testnet</span>
      <span>{compact ? "No real funds." : "Demo timers run in minutes. No real funds."}</span>
    </div>
  );
}

/** The mark: a dark disc with a blue ring (light variant on dark surfaces). */
export function Mark({ size = 28, light }: { size?: number; light?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="14" fill={light ? "#FEFEFE" : "currentColor"} />
      <circle cx="14" cy="14" r="8" fill="none" stroke="#2F6BFF" strokeWidth="2.5" />
      <circle cx="14" cy="14" r="3" fill={light ? "#262626" : "var(--paper)"} />
    </svg>
  );
}

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <Link href="/" className={cx("flex items-center gap-2.5 no-underline", dark ? "text-white" : "text-ink")} aria-label="Behest home">
      <Mark light={dark} />
      <span className="text-[21px] font-semibold tracking-[-0.03em]">behest</span>
    </Link>
  );
}

/** Light / dark / system. The choice is stored per browser and applied before paint (layout). */
export function ThemeToggle({ dark }: { dark?: boolean }) {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("behest-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  function cycle() {
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("behest-theme");
      else localStorage.setItem("behest-theme", next);
    } catch {}
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  }
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme}`}
      className={cx("flex h-11 w-11 items-center justify-center rounded-tile", dark ? "text-[#D4D4D4] hover:bg-white/10" : "text-ink hover:bg-subtle")}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "dark" ? (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        ) : theme === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
          </>
        )}
      </svg>
    </button>
  );
}

export function AccountButton({ dark, full }: { dark?: boolean; full?: boolean }) {
  const { session, ready, signOut } = useSession();
  const [open, setOpen] = useState(false);
  if (!ready) return <span className="h-11 w-24" aria-hidden="true" />;
  if (!session) {
    return (
      <>
        <Button variant={dark ? "primary" : "ink"} className={cx("min-h-11", full && "w-full")} onClick={() => setOpen(true)}>
          Sign in
        </Button>
        <SignInDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  }
  return (
    <div className={cx("flex min-w-0 items-center gap-1", full && "w-full")}>
      <Link href="/app" className={cx("flex min-h-11 min-w-0 items-center gap-2 rounded-tile px-2 sm:px-3", full ? "flex-1" : "max-w-[132px] sm:max-w-[220px]", dark ? "text-white hover:bg-white/10" : "hover:bg-subtle")} title={session.accountId}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-signal" aria-hidden="true" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm">{session.kind === "persona" ? session.label : session.accountId}</span>
          <span className={cx("truncate text-xs", dark ? "text-muted-dark" : "text-muted")}>{session.via}</span>
        </span>
      </Link>
      <button onClick={() => void signOut()} className={cx("min-h-11 shrink-0 whitespace-nowrap rounded-tile px-2.5 text-sm", dark ? "text-muted-dark hover:bg-white/10" : "text-muted hover:bg-subtle")}>
        Sign out
      </button>
    </div>
  );
}

/** Public site header: 1280px container framed by hairlines. */
export function SiteHeader({ links }: { links?: [string, string][] }) {
  return (
    <header className="border-b border-hairline">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 border-x border-hairline px-4 py-4 sm:px-8">
        <Logo />
        {links && (
          <nav aria-label="Sections" className="hidden gap-1 text-[15px] md:flex">
            {links.map(([h, l]) => (
              <a key={h} href={h} className="rounded-tile px-3 py-2.5 text-muted hover:bg-subtle hover:text-ink">
                {l}
              </a>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <AccountButton />
        </div>
      </div>
    </header>
  );
}

const APP_LINKS = [
  { href: "/app", label: "Home" },
  { href: "/setup", label: "Create a plan" },
  { href: "/try", label: "Try as…" },
  { href: "/inspect", label: "Inspect a plan" },
];

export function NavItem({ active, children, ...p }: { active?: boolean; children: ReactNode } & ({ href: string; onClick?: never } | { onClick: () => void; href?: never })) {
  const cls = cx("flex h-11 shrink-0 items-center whitespace-nowrap rounded-tile px-3 text-left text-[15px]", active ? "bg-white/[0.08] text-white" : "text-[#D4D4D4] hover:bg-white/[0.05]");
  return p.href ? (
    <Link href={p.href} aria-current={active ? "page" : undefined} className={cls}>
      {children}
    </Link>
  ) : (
    <button onClick={p.onClick} aria-current={active ? "page" : undefined} className={cls}>
      {children}
    </button>
  );
}

/**
 * App frame from the design's dashboard: a dark frame with the sidebar
 * (logo, navigation, account) around a light content panel. On small
 * screens the sidebar becomes a top bar with scrolling navigation.
 */
export function AppShell({ children, nav, mainClassName, narrow }: { children: ReactNode; nav?: ReactNode; mainClassName?: string; narrow?: boolean }) {
  const path = usePathname();
  return (
    <div data-app-shell className="flex min-h-dvh flex-col bg-frame lg:h-dvh lg:overflow-hidden">
      <TestnetBar />
      <div className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[232px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col text-[#D4D4D4] lg:min-h-0 lg:overflow-y-auto">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3 lg:px-6 lg:py-5">
            <Logo dark />
            <div className="flex items-center gap-1 lg:hidden">
              <ThemeToggle dark />
              <AccountButton dark />
            </div>
          </div>
          <nav aria-label="Main" className="flex gap-0.5 overflow-x-auto p-2 lg:flex-col lg:p-3">
            {APP_LINKS.map((l) => (
              <NavItem key={l.href} href={l.href} active={path === l.href}>
                {l.label}
              </NavItem>
            ))}
            {nav}
          </nav>
          <div className="mt-auto hidden flex-col gap-2 p-3 lg:flex">
            <div className="flex items-center justify-between">
              <span className="px-1 text-xs text-[#A1A1A1]">Testnet · demo timers</span>
              <ThemeToggle dark />
            </div>
            <div className="rounded-tile bg-white/[0.06] p-1">
              <AccountButton dark full />
            </div>
          </div>
        </aside>
        <div className="relative min-w-0 rounded-tile bg-paper dark-panel lg:my-2 lg:mr-2 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          <main className={cx("mx-auto flex w-full flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8", narrow ? "max-w-[560px]" : "max-w-[1040px]", mainClassName)}>{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Small label shown above a group of sidebar items. */
export function NavLabel({ children }: { children: ReactNode }) {
  return <span className="hidden px-3 pb-1.5 pt-6 text-[13px] text-[#737373] lg:block">{children}</span>;
}
