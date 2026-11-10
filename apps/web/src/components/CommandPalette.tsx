"use client";
// ⌘K / Ctrl+K: jump to a page, open a plan by account, switch test persona,
// change theme or sign out, all from the keyboard.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileSearch, LogOut, Monitor, Moon, Search, Sun, UserRound, Users, type LucideIcon } from "lucide-react";
import { loadSandbox, watched, PERSONA_ROLES } from "@/lib/demo";
import { shortName } from "@/lib/plan";
import { useSession } from "@/lib/session";
import { looksLikeNearAccount } from "@/lib/wizard";
import { NAV } from "./chrome";
import { useTheme } from "./theme";
import { Kbd, cx } from "./ui";

interface Cmd {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

export function useCommandPalette() {
  const [isOpen, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return { isOpen, open: useCallback(() => setOpen(true), []), close: useCallback(() => setOpen(false), []) };
}

export function CommandPalette({ isOpen, close }: { isOpen: boolean; close: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { session, actAsPersona, signOut } = useSession();
  const { setTheme } = useTheme();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (isOpen && !d.open) {
      setQ("");
      setSel(0);
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!isOpen && d.open) d.close();
  }, [isOpen]);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  const cmds = useMemo<Cmd[]>(() => {
    if (!isOpen) return [];
    const out: Cmd[] = NAV.map((n) => ({ id: `nav:${n.href}`, label: n.label, group: "Go to", icon: n.icon, run: () => go(n.href) }));
    if (session) out.push({ id: "mine", label: "Your plan", group: "Go to", icon: UserRound, run: () => go(`/plan/${encodeURIComponent(session.accountId)}`) });
    for (const o of watched().slice(0, 6))
      out.push({ id: `w:${o}`, label: `${shortName(o)}'s plan`, hint: o, group: "Recent plans", icon: FileSearch, run: () => go(`/plan/${encodeURIComponent(o)}`) });
    const sb = loadSandbox();
    if (sb)
      for (const r of PERSONA_ROLES) {
        const p = sb.personas[r];
        if (p.accountId === session?.accountId) continue;
        out.push({
          id: `p:${r}`,
          label: `Act as ${p.label}`,
          group: "Test personas",
          icon: Users,
          run: () => {
            actAsPersona(p);
            go(`/plan/${encodeURIComponent(sb.personas.owner.accountId)}`);
          },
        });
      }
    out.push(
      { id: "t:light", label: "Light theme", group: "Appearance", icon: Sun, run: () => (setTheme("light"), close()) },
      { id: "t:dark", label: "Dark theme", group: "Appearance", icon: Moon, run: () => (setTheme("dark"), close()) },
      { id: "t:system", label: "Match system theme", group: "Appearance", icon: Monitor, run: () => (setTheme("system"), close()) },
    );
    if (session) out.push({ id: "out", label: "Sign out", group: "Account", icon: LogOut, run: () => (close(), void signOut()) });
    return out;
  }, [isOpen, session, go, actAsPersona, setTheme, signOut, close]);

  const term = q.trim().toLowerCase();
  const list = useMemo(() => {
    const hits = term ? cmds.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(term)) : cmds;
    if (term && looksLikeNearAccount(term))
      return [{ id: "inspect", label: `Open ${term}'s plan`, group: "Inspect", icon: Search, run: () => go(`/plan/${encodeURIComponent(term)}?view=inspect`) }, ...hits];
    return hits;
  }, [cmds, term, go]);

  useEffect(() => {
    setSel(0);
  }, [term]);
  useEffect(() => {
    document.getElementById(`cmd-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === ref.current && close()}
      aria-label="Search and quick actions"
      className="behest-dialog mx-auto mb-auto mt-[12vh] w-[min(600px,calc(100vw-24px))] overflow-hidden rounded-card border border-line bg-paper p-0 text-ink shadow-float"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search aria-hidden className="size-5 shrink-0 text-muted" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(list.length - 1, s + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            if (e.key === "Enter") (e.preventDefault(), list[sel]?.run());
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={list[sel] ? `cmd-${sel}` : undefined}
          placeholder="Type a page, an action, or an account to inspect…"
          className="min-h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="hidden sm:block">
          <Kbd>esc</Kbd>
        </span>
      </div>
      <ul id="cmd-list" role="listbox" aria-label="Results" className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
        {list.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">Nothing matches. Type a NEAR account (e.g. kemi.testnet) to inspect its plan.</li>}
        {list.map((c, i) => {
          const header = c.group !== lastGroup;
          lastGroup = c.group;
          const I = c.icon;
          return (
            <li key={c.id} role="presentation">
              {header && <div className="px-3 pb-1 pt-3 text-xs font-semibold text-muted first:pt-1">{c.group}</div>}
              <div
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === sel}
                onMouseMove={() => setSel(i)}
                onClick={() => c.run()}
                className={cx("flex min-h-11 cursor-pointer items-center gap-3 rounded-tile px-3 text-[15px]", i === sel && "bg-subtle")}
              >
                <I aria-hidden className="size-[18px] shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="hidden max-w-[40%] truncate font-mono text-xs text-muted sm:block">{c.hint}</span>}
                {i === sel && <CornerDownLeft aria-hidden className="size-4 shrink-0 text-muted" />}
              </div>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
