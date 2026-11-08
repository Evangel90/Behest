"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { Button, cx } from "./ui";
import { SignInDialog } from "./SignIn";

export function TestnetBar({ compact }: { compact?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap justify-center gap-x-3 bg-testnet px-4 py-2 text-center font-mono text-[11px] font-bold uppercase tracking-wide text-ink sm:text-xs">
      <span>● Testnet</span>
      <span>{compact ? "No real value" : "Demo timers: 1 day = 1 minute · no real funds"}</span>
    </div>
  );
}

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="Behest home">
      <span className={cx("flex h-[34px] w-[34px] items-center justify-center rounded-[10px]", dark ? "bg-mint" : "bg-ink")} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="7" stroke={dark ? "#0B0B0B" : "#00E59B"} strokeWidth="2" />
          <circle cx="9" cy="9" r="3" fill={dark ? "#0B0B0B" : "#00E59B"} />
        </svg>
      </span>
      <span className="font-display text-2xl font-bold tracking-[-0.03em]">behest</span>
    </Link>
  );
}

export function AccountButton({ dark }: { dark?: boolean }) {
  const { session, ready, signOut } = useSession();
  const [open, setOpen] = useState(false);
  if (!ready) return <span className="h-12 w-32" aria-hidden="true" />;
  if (!session) {
    return (
      <>
        <Button variant={dark ? "mint" : "ink"} onClick={() => setOpen(true)}>
          Sign in
        </Button>
        <SignInDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/app"
        className={cx("flex min-h-12 max-w-[220px] items-center gap-2 rounded-full border-[1.5px] px-3", dark ? "border-line-dark text-paper" : "border-ink")}
        title={session.accountId}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-mint" aria-hidden="true" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold">{session.kind === "persona" ? session.label : session.accountId}</span>
          <span className={cx("truncate font-mono text-[10.5px]", dark ? "text-muted-dark" : "text-muted")}>{session.via}</span>
        </span>
      </Link>
      <button onClick={() => void signOut()} className={cx("min-h-12 px-2 text-sm underline-offset-4 hover:underline", dark ? "text-muted-dark" : "text-muted")}>
        Sign out
      </button>
    </div>
  );
}

export function AppHeader() {
  const path = usePathname();
  const links = [
    { href: "/app", label: "Home" },
    { href: "/setup", label: "Create plan" },
    { href: "/try", label: "Try as…" },
    { href: "/inspect", label: "Inspect" },
  ];
  return (
    <header className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto text-[15px] font-medium sm:order-none sm:w-auto">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
              className={cx("whitespace-nowrap rounded-full px-3.5 py-2.5", path === l.href ? "bg-ink text-paper" : "hover:bg-line-soft")}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <AccountButton />
      </div>
    </header>
  );
}
