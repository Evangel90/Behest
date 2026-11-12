"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, ChevronsUpDown, CirclePlus, FlaskConical, House, Landmark, LogOut, Menu, Monitor, Moon, Repeat, Search, Sun, UserRound, Wallet, type LucideIcon } from "lucide-react";
import { loadSandbox, PERSONA_ROLES, type Sandbox } from "@/lib/demo";
import { humanError } from "@/lib/hooks";
import { shortAddr, shortName } from "@/lib/plan";
import { useSession } from "@/lib/session";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { DaoPicker } from "./Dao";
import { useToast } from "./feedback";
import { CopyButton, Dialog, Segmented } from "./interactive";
import { PICK_DAO, SignInDialog } from "./SignIn";
import { useTheme, type Theme } from "./theme";
import { Button, Kbd, cx } from "./ui";

// ---------------------------------------------------------------- navigation
// The app's main navigation, in order. Add an entry here and it appears in the
// desktop sidebar, the phone tab bar and the command palette.

export interface NavEntry {
  href: string;
  label: string;
  /** Shorter label for the phone tab bar. */
  short?: string;
  icon: LucideIcon;
}

export const NAV: NavEntry[] = [
  { href: "/app", label: "Home", icon: House },
  { href: "/setup", label: "Create a plan", short: "Create", icon: CirclePlus },
  { href: "/try", label: "Try as…", short: "Try", icon: FlaskConical },
  { href: "/inspect", label: "Inspect a plan", short: "Inspect", icon: Search },
  { href: "/notifications", label: "Notifications", short: "Alerts", icon: Bell },
];

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

// -------------------------------------------------------------------- brand

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
    <Link href="/" className={cx("flex min-h-11 items-center gap-2.5 rounded-tile no-underline", dark ? "text-white" : "text-ink")} aria-label="Behest home">
      <Mark light={dark} />
      <span className="text-[21px] font-semibold tracking-[-0.03em]">behest</span>
    </Link>
  );
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** One-button theme cycle: system → light → dark. */
export function ThemeToggle({ dark }: { dark?: boolean }) {
  const { theme, setTheme } = useTheme();
  const i = THEMES.findIndex((t) => t.value === theme);
  const next = THEMES[(i + 1) % THEMES.length]!;
  const I = THEMES[i]?.icon ?? Monitor;
  return (
    <button
      onClick={() => setTheme(next.value)}
      aria-label={`Theme: ${theme}. Switch to ${next.label.toLowerCase()}.`}
      title={`Theme: ${theme}`}
      className={cx("flex size-11 shrink-0 items-center justify-center rounded-tile transition-colors", dark ? "text-[#D4D4D4] hover:bg-white/10 hover:text-white" : "text-ink hover:bg-subtle")}
    >
      <I key={theme} aria-hidden className="size-[18px] animate-pop" />
    </button>
  );
}

/** The three theme choices side by side (menus and sheets). */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return <Segmented label="Theme" size="sm" value={theme} onChange={setTheme} options={THEMES.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))} className="w-full [&>button]:flex-1" />;
}

// ------------------------------------------------------------------ account

function initials(label: string) {
  return (label.trim()[0] ?? "?").toUpperCase();
}

/** Signed in: an account chip that opens a menu (copy id, switch persona, theme, sign out). Signed out: a sign-in button. */
export function AccountButton({ dark, full, compact }: { dark?: boolean; full?: boolean; compact?: boolean }) {
  const { session, ready, signOut, actAsPersona, leaveDao, lastEvm, backToEvm } = useSession();
  const toast = useToast();
  const router = useRouter();
  const [signIn, setSignIn] = useState(false);
  const [daoPick, setDaoPick] = useState(false);
  // Signed in through "A DAO or multisig": go straight to picking the DAO.
  useEffect(() => {
    if (!session || session.kind === "evm" || session.dao) return;
    try {
      if (sessionStorage.getItem(PICK_DAO)) {
        sessionStorage.removeItem(PICK_DAO);
        setDaoPick(true);
      }
    } catch {}
  }, [session]);
  const [open, setOpen] = useState(false);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  useEffect(() => {
    if (open) setSandbox(loadSandbox());
  }, [open]);

  if (!ready) return <span className={cx("h-11 rounded-tile", full ? "w-full" : "w-24", dark ? "bg-white/[0.06]" : "skeleton")} aria-hidden="true" />;
  if (!session) {
    return (
      <>
        <Button variant={dark ? "primary" : "ink"} size="sm" icon={UserRound} className={cx(full && "w-full")} onClick={() => setSignIn(true)}>
          Sign in
        </Button>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </>
    );
  }
  const name = session.kind === "persona" ? session.label : session.accountId;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cx(
          "flex min-h-11 min-w-0 items-center gap-2.5 rounded-tile px-1.5 text-left transition-colors",
          full ? "w-full" : compact ? "" : "max-w-[220px] pr-2.5",
          dark ? "text-white hover:bg-white/10" : "hover:bg-subtle",
        )}
        title={session.accountId}
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#A9CCFF] text-sm font-semibold text-[#0A0A0A]">
          {initials(session.kind === "persona" ? session.label : shortName(session.accountId))}
        </span>
        {!compact && (
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm">{name}</span>
            <span className={cx("truncate text-xs", dark ? "text-muted-dark" : "text-muted")}>{session.via}</span>
          </span>
        )}
        {!compact && <ChevronsUpDown aria-hidden className={cx("size-4 shrink-0", dark ? "text-muted-dark" : "text-muted")} />}
        <span className="sr-only">Account menu</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Your account" sheet bottom description={`Signed in with ${session.via}.`}>
        <div className="flex items-center gap-2 rounded-row bg-subtle p-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={session.accountId}>
            {session.accountId}
          </span>
          <CopyButton value={session.accountId} label="Copy account" />
        </div>
        <div className="flex flex-col gap-1">
          <MenuLink
            icon={House}
            onClick={() => {
              setOpen(false);
              router.push("/app");
            }}
          >
            Home
          </MenuLink>
          <MenuLink
            icon={UserRound}
            onClick={() => {
              setOpen(false);
              router.push(`/plan/${encodeURIComponent(session.accountId)}`);
            }}
          >
            {session.dao ? "The DAO's plan" : "Your plan"}
          </MenuLink>
          {session.kind !== "evm" && (
            <MenuLink
              icon={Landmark}
              onClick={() => {
                setOpen(false);
                setDaoPick(true);
              }}
            >
              {session.dao ? "Act as another DAO" : "Act as a DAO"}
            </MenuLink>
          )}
          {session.kind === "persona" && lastEvm && (
            <MenuLink
              icon={Wallet}
              onClick={async () => {
                setOpen(false);
                try {
                  await backToEvm();
                  router.push("/app");
                } catch (e) {
                  toast.show({ tone: "error", title: `Couldn't reconnect ${lastEvm.name}`, body: humanError(e) });
                }
              }}
            >
              Back to {lastEvm.name} ({shortAddr(lastEvm.address)})
            </MenuLink>
          )}
          <MenuLink
            icon={Repeat}
            onClick={() => {
              setOpen(false);
              setSignIn(true);
            }}
          >
            Use another account
          </MenuLink>
          {session.dao && (
            <MenuLink
              icon={UserRound}
              onClick={() => {
                setOpen(false);
                leaveDao();
              }}
            >
              Back to {session.dao.member.label}
            </MenuLink>
          )}
        </div>
        {sandbox && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Switch test persona</span>
            <div className="grid grid-cols-2 gap-1.5">
              {PERSONA_ROLES.map((r) => {
                const p = sandbox.personas[r];
                const on = p.accountId === session.accountId;
                return (
                  <button
                    key={r}
                    disabled={on}
                    onClick={() => {
                      actAsPersona(p);
                      setOpen(false);
                      router.push(`/plan/${encodeURIComponent(sandbox.personas.owner.accountId)}`);
                    }}
                    className={cx("flex min-h-11 items-center gap-2 rounded-tile border px-3 text-left text-sm", on ? "border-signal bg-s-approved" : "border-line hover:bg-subtle")}
                  >
                    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold">
                      {initials(p.label)}
                    </span>
                    <span className="truncate">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Appearance</span>
          <ThemeSwitch />
        </div>
        <Button
          variant="outline"
          icon={LogOut}
          className="mt-auto"
          onClick={() => {
            setOpen(false);
            void signOut();
          }}
        >
          Sign out
        </Button>
      </Dialog>
      <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      <DaoPicker open={daoPick} onClose={() => setDaoPick(false)} onDone={(dao) => router.push(`/plan/${encodeURIComponent(dao)}`)} />
    </>
  );
}

function MenuLink({ icon: I, children, onClick }: { icon: LucideIcon; children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-12 items-center gap-3 rounded-tile px-3 text-left text-[15px] hover:bg-subtle">
      <I aria-hidden className="size-[18px] text-muted" />
      {children}
    </button>
  );
}

// ------------------------------------------------------------- site header

/** Public site header: 1280px container framed by hairlines; a menu sheet on phones. */
export function SiteHeader({ links }: { links?: [string, string][] }) {
  const [menu, setMenu] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 border-x border-hairline px-4 py-2.5 sm:px-8">
        <Logo />
        {links && (
          <nav aria-label="Sections" className="hidden gap-1 text-[15px] md:flex">
            {links.map(([h, l]) => (
              <a key={h} href={h} className="rounded-tile px-3 py-2.5 text-muted transition-colors hover:bg-subtle hover:text-ink">
                {l}
              </a>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <span className="hidden sm:block">
            <AccountButton />
          </span>
          {links && (
            <button onClick={() => setMenu(true)} aria-label="Open menu" className="flex size-11 items-center justify-center rounded-tile hover:bg-subtle md:hidden">
              <Menu aria-hidden className="size-5" />
            </button>
          )}
        </div>
      </div>
      {links && (
        <Dialog open={menu} onClose={() => setMenu(false)} title="Menu" sheet>
          <nav aria-label="Sections" className="flex flex-col gap-1">
            {links.map(([h, l]) => (
              <a key={h} href={h} onClick={() => setMenu(false)} className="flex min-h-12 items-center rounded-tile px-3 text-lg hover:bg-subtle">
                {l}
              </a>
            ))}
            <Link href="/app" onClick={() => setMenu(false)} className="flex min-h-12 items-center rounded-tile px-3 text-lg hover:bg-subtle">
              Open the app
            </Link>
          </nav>
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <AccountButton full />
            <ThemeSwitch />
          </div>
        </Dialog>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- app shell

export function NavItem({ active, icon: I, children, badge, ...p }: { active?: boolean; icon?: LucideIcon; badge?: ReactNode; children: ReactNode } & ({ href: string; onClick?: never } | { onClick: () => void; href?: never })) {
  const cls = cx(
    "group relative flex h-11 shrink-0 items-center gap-3 whitespace-nowrap rounded-tile px-3 text-left text-[15px] transition-colors duration-150",
    active ? "bg-white/[0.08] text-white" : "text-[#D4D4D4] hover:bg-white/[0.05] hover:text-white",
  );
  const inner = (
    <>
      {active && <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-signal" />}
      {I && <I aria-hidden className={cx("size-[18px] shrink-0", active ? "text-[#A9C4FF]" : "text-[#A1A1A1] group-hover:text-white")} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
    </>
  );
  return p.href ? (
    <Link href={p.href} aria-current={active ? "page" : undefined} className={cls}>
      {inner}
    </Link>
  ) : (
    <button onClick={p.onClick} aria-current={active ? "page" : undefined} className={cls}>
      {inner}
    </button>
  );
}

/** Small label shown above a group of sidebar items. */
export function NavLabel({ children }: { children: ReactNode }) {
  return <span className="hidden px-3 pb-1.5 pt-6 text-[13px] text-[#8A8A8A] lg:block">{children}</span>;
}

function SearchButton({ onOpen, wide }: { onOpen: () => void; wide?: boolean }) {
  if (!wide)
    return (
      <button onClick={onOpen} aria-label="Search and quick actions" className="flex size-11 items-center justify-center rounded-tile text-[#D4D4D4] hover:bg-white/10 hover:text-white">
        <Search aria-hidden className="size-[18px]" />
      </button>
    );
  return (
    <button onClick={onOpen} className="flex h-11 w-full items-center gap-2.5 rounded-tile border border-white/10 px-3 text-left text-sm text-[#A1A1A1] transition-colors hover:border-white/20 hover:text-white">
      <Search aria-hidden className="size-4" />
      <span className="flex-1 truncate">Search…</span>
      <span className="flex gap-0.5 [&>kbd]:border-white/15 [&>kbd]:bg-white/5 [&>kbd]:text-[#A1A1A1]">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

/**
 * App frame from the design's dashboard: a dark frame with the sidebar
 * (logo, search, navigation, account) around a light content panel. On
 * phones the sidebar becomes a top bar plus a bottom tab bar.
 */
export function AppShell({ children, nav, mainClassName, narrow }: { children: ReactNode; nav?: ReactNode; mainClassName?: string; narrow?: boolean }) {
  const path = usePathname();
  const palette = useCommandPalette();
  const panel = useRef<HTMLDivElement>(null);
  // Each page starts at the top of the content panel.
  useEffect(() => {
    panel.current?.scrollTo(0, 0);
  }, [path]);
  return (
    <div data-app-shell className="flex min-h-dvh flex-col bg-frame lg:h-dvh lg:overflow-hidden">
      <a href="#main" className="sr-only z-[90] rounded-tile bg-primary px-4 py-3 text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <div className="grid flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:min-h-0 lg:grid-cols-[248px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <aside className="sticky top-0 z-30 flex min-w-0 flex-col bg-frame text-[#D4D4D4] lg:static lg:min-h-0 lg:overflow-y-auto">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 lg:px-6 lg:py-5">
            <Logo dark />
            <div className="flex items-center gap-0.5 lg:hidden">
              <SearchButton onOpen={palette.open} />
              <ThemeToggle dark />
              <AccountButton dark compact />
            </div>
          </div>
          <div className="hidden px-3 pt-3 lg:block">
            <SearchButton onOpen={palette.open} wide />
          </div>
          <nav aria-label="Main" className="hidden flex-col gap-0.5 p-3 lg:flex">
            {NAV.map((l) => (
              <NavItem key={l.href} href={l.href} icon={l.icon} active={isActive(path, l.href)}>
                {l.label}
              </NavItem>
            ))}
            {nav}
          </nav>
          <div className="mt-auto hidden flex-col gap-2 p-3 lg:flex">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 px-1 text-xs text-[#A1A1A1]">
                <span aria-hidden className="size-1.5 animate-breathe rounded-full bg-[#70FFCD]" />
                Testnet · demo timers
              </span>
              <ThemeToggle dark />
            </div>
            <div className="rounded-tile bg-white/[0.06] p-1">
              <AccountButton dark full />
            </div>
          </div>
        </aside>
        <div ref={panel} className="relative min-w-0 rounded-t-tile bg-paper dark-panel lg:my-2 lg:mr-2 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:rounded-tile">
          <main
            id="main"
            tabIndex={-1}
            className={cx(
              "mx-auto flex w-full animate-fade-up flex-col gap-6 px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-6 outline-none sm:px-8 sm:pt-8 lg:pb-10",
              narrow ? "max-w-[600px]" : "max-w-[1080px]",
              mainClassName,
            )}
          >
            {children}
          </main>
        </div>
      </div>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-frame/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        <ul className="mx-auto flex max-w-[560px]">
          {NAV.map((l) => {
            const on = isActive(path, l.href);
            const I = l.icon;
            return (
              <li key={l.href} className="flex-1">
                <Link href={l.href} aria-current={on ? "page" : undefined} className={cx("flex min-h-[60px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors", on ? "text-white" : "text-[#A1A1A1] hover:text-white")}>
                  <span className={cx("flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200", on && "bg-white/[0.12]")}>
                    <I aria-hidden className={cx("size-[19px]", on && "text-[#A9C4FF]")} />
                  </span>
                  {l.short ?? l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <CommandPalette {...palette} />
    </div>
  );
}
