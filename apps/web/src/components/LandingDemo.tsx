"use client";
// Landing-page demo: an example plan in the dashboard frame. Tabs and the
// check-in button work locally; nothing touches the chain.
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Ban, BadgeCheck, Check, Coins, EyeOff, Gift, HeartPulse, History, Hourglass, LayoutGrid, Mail, ShieldCheck, Sparkles, Split, type LucideIcon } from "lucide-react";
import { Mark } from "./chrome";
import { motion, Swap } from "./motion";
import { cx } from "./ui";

const TABS = [
  ["plan", "Plan", LayoutGrid],
  ["heirs", "Heirs", Gift],
  ["guardians", "Guardians", ShieldCheck],
  ["activity", "Activity", History],
] as const;
type Tab = (typeof TABS)[number][0];

const ASSETS = [
  { k: "BTC", c: "#FB7A1E", name: "Bitcoin", amt: "0.0004 BTC · testnet4 vault", tag: "Fees reserved" },
  { k: "ETH", c: "#6366F1", name: "Ethereum", amt: "0.02 ETH · 0.01 WETH · Sepolia vault", tag: "Fees reserved" },
  { k: "NEAR", c: "#171717", name: "NEAR", amt: "0.05 NEAR · 0.01 wNEAR in escrow", tag: "Gas sponsored" },
];
const HEIRS = [
  { i: "A", n: "Amara", d: "amara@example.com", p: "60%", c: "#A9CCFF" },
  { i: "T", n: "Tobi", d: "BTC · tb1qdj8g…u7en", p: "40%", c: "#FDBA8C" },
];
const GUARDIANS = ["Dayo", "Funmi", "Chidi"];
const ACTIVITY = [
  ["Check-in recorded", "Gas paid by Behest", "today"],
  ["Release rules set", "Remainder to Amara", "2 days ago"],
  ["Bitcoin vault funded", "30,000 sats", "5 days ago"],
  ["Plan created", "Version 1", "1 week ago"],
];

export function LandingDemo() {
  const [tab, setTab] = useState<Tab>("plan");
  const [checkedIn, setCheckedIn] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + TABS.length) % TABS.length;
    setTab(TABS[j]![0]);
    tabs.current[j]?.focus();
  };
  const days = checkedIn ? 90 : 18;
  const C = 2 * Math.PI * 23;
  return (
    <div className="grid overflow-hidden rounded-[20px] bg-[#262626] text-left md:grid-cols-[232px_minmax(0,1fr)]">
      <div className="flex flex-col text-[#D4D4D4]">
        <div className="flex items-center gap-2.5 border-b border-white/10 px-6 py-5 text-white">
          <Mark size={22} light />
          <span className="font-semibold">behest</span>
        </div>
        <div role="tablist" aria-label="Example plan" aria-orientation="vertical" className="flex gap-0.5 overflow-x-auto p-3 md:flex-col">
          {TABS.map(([k, label, I], i) => (
            <button
              key={k}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              role="tab"
              id={`demo-tab-${k}`}
              aria-selected={tab === k}
              aria-controls="demo-panel"
              tabIndex={tab === k ? 0 : -1}
              onClick={() => setTab(k)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx("relative flex h-11 shrink-0 items-center gap-2.5 rounded-tile px-3 text-left text-[15px] transition-colors", tab === k ? "text-white" : "hover:bg-white/[0.04] hover:text-white")}
            >
              {tab === k && <motion.span layoutId="demo-tab" aria-hidden className="absolute inset-0 rounded-tile bg-white/[0.08]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
              <I aria-hidden className="relative size-[18px]" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div id="demo-panel" role="tabpanel" aria-labelledby={`demo-tab-${tab}`} className="m-2 min-h-[520px] overflow-hidden rounded-tile bg-card p-5 text-ink sm:p-8 md:ml-0">
        <Swap id={tab} className="mx-auto flex max-w-[704px] flex-col gap-8">
          {tab === "plan" && (
            <>
              <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-base text-muted">Example plan · testnet</span>
                  <span className="text-[40px] leading-none tracking-[-0.03em]">3 chains, 2 heirs</span>
                </div>
                <button
                  onClick={() => setCheckedIn((c) => !c)}
                  aria-pressed={checkedIn}
                  className={cx("inline-flex h-11 items-center gap-2 rounded-[12px] px-4 text-sm font-semibold transition-colors active:scale-[0.97]", checkedIn ? "bg-[rgba(47,107,255,.14)] text-signal-text" : "bg-ink text-ink-contrast hover:bg-black")}
                >
                  {checkedIn ? <Check key="c" aria-hidden className="size-4 animate-pop" /> : <HeartPulse aria-hidden className="size-4" />}
                  {checkedIn ? "Checked in" : "Check in"}
                </button>
              </header>
              <div className="rounded-row border border-line bg-subtle px-1 pb-1">
                <div className="px-6 py-3 text-sm font-semibold">Balances</div>
                <ul className="overflow-hidden rounded-tile border border-line bg-card">
                  {ASSETS.map((a, i) => (
                    <li key={a.k} className={cx("grid items-center gap-3 px-5 py-4 sm:grid-cols-[1.4fr_1fr] sm:px-6", i > 0 && "border-t border-line")}>
                      <span className="flex items-center gap-3">
                        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: a.c }}>
                          {a.k}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[15px]">{a.name}</span>
                          <span className="text-sm text-muted">{a.amt}</span>
                        </span>
                      </span>
                      <span className="inline-flex h-6 items-center gap-1 justify-self-start rounded-tag bg-ok-bg pl-1.5 pr-2 text-[13px] text-ok sm:justify-self-end">
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                        {a.tag}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-4 rounded-row border border-line p-5">
                  <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
                    <circle cx="28" cy="28" r="23" fill="none" stroke="#EDEDED" strokeWidth="6" />
                    <circle cx="28" cy="28" r="23" fill="none" stroke="#2F6BFF" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${((C * days) / 90).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 28 28)" className="transition-[stroke-dasharray] duration-700 ease-ledger" />
                  </svg>
                  <div className="flex flex-col">
                    <span key={days} className="animate-fade-up text-[22px] tracking-[-0.02em]">{days} days</span>
                    <span className="text-sm text-muted">until the next check-in</span>
                  </div>
                </div>
                <div className="flex flex-col justify-center rounded-row border border-line p-5">
                  <span className="text-[22px] tracking-[-0.02em]">2 of 3</span>
                  <span className="text-sm text-muted">guardians to release</span>
                </div>
              </div>
            </>
          )}
          {tab === "heirs" && (
            <>
              <DemoHead k="Heirs" t="Who receives what" />
              <div className="flex h-2.5 gap-[3px]" aria-hidden="true">
                <span className="w-[60%] rounded-tag bg-[#2F6BFF]" />
                <span className="w-[40%] rounded-tag bg-[#FB7A1E]" />
              </div>
              <ul className="overflow-hidden rounded-tile border border-line">
                {HEIRS.map((h, i) => (
                  <li key={h.n} className={cx("grid items-center gap-2 px-5 py-4 sm:grid-cols-[1fr_1.3fr_auto] sm:px-6", i > 0 && "border-t border-line")}>
                    <span className="flex items-center gap-3">
                      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full text-sm" style={{ background: h.c }}>
                        {h.i}
                      </span>
                      {h.n}
                    </span>
                    <span className="font-mono text-[13px] text-muted">{h.d}</span>
                    <span className="text-lg sm:text-right">{h.p}</span>
                  </li>
                ))}
              </ul>
              <span className="text-sm text-muted">Destinations are fixed. Nobody else can change them.</span>
            </>
          )}
          {tab === "guardians" && (
            <>
              <DemoHead k="Guardians" t="Any 2 of 3" />
              <ul className="overflow-hidden rounded-tile border border-line">
                {GUARDIANS.map((g, i) => (
                  <li key={g} className={cx("flex items-center justify-between px-6 py-4", i > 0 && "border-t border-line")}>
                    <span>{g}</span>
                    <span className="inline-flex h-6 items-center rounded-tag bg-ok-bg px-2 text-[13px] text-ok">Standing by</span>
                  </li>
                ))}
              </ul>
              <span className="text-sm text-muted">They can start a release if you stop checking in. They can never redirect funds.</span>
            </>
          )}
          {tab === "activity" && (
            <>
              <DemoHead k="Activity" t="Recent" />
              <ul className="overflow-hidden rounded-tile border border-line">
                {ACTIVITY.map(([t, d, w], i) => (
                  <li key={t} className={cx("grid gap-1 px-6 py-4 sm:grid-cols-[1.2fr_1.2fr_auto] sm:items-center", i > 0 && "border-t border-line")}>
                    <span>{t}</span>
                    <span className="text-sm text-muted">{d}</span>
                    <span className="text-sm text-muted sm:text-right">{w}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Swap>
      </div>
    </div>
  );
}

function DemoHead({ k, t }: { k: string; t: string }) {
  return (
    <header className="flex flex-col gap-1">
      <span className="text-base text-muted">{k}</span>
      <span className="text-[40px] leading-none tracking-[-0.03em]">{t}</span>
    </header>
  );
}

type Panel = "split" | "quorum" | "checkin" | "private" | "notice" | "proof" | "preset" | "email";
const FEATURES: { t: string; b: string; p: Panel; icon: LucideIcon }[] = [
  { t: "Start from a preset", b: "Careful, Balanced or Quick fill in sensible timers, guardians and safety settings, and explain every one. Change anything. Before you save, the whole plan is read back to you in plain words, with warnings for risky choices.", p: "preset", icon: Sparkles },
  { t: "Heirs claim with just an email", b: "Name a heir or a guardian by their email address. When the time comes they get a message, sign in with a code from their inbox and receive their share. No wallet, no seed phrase, nothing to install. They can send it on to an exchange or their own wallet from the same screen.", p: "email", icon: Mail },
  { t: "Split across your heirs", b: "Give each person a share by email, or a fixed address on the chain they use: NEAR, Ethereum or Bitcoin, or their NEAR Intents account. Add fixed amounts, a remainder rule, alternates and a fallback.", p: "split", icon: Split },
  { t: "Keep your heirs private", b: "Choose private and the chain holds only a fingerprint of each heir. Who inherits, how much and where stay hidden until you stop checking in. Each heir then reveals their own recovery record, from their printed packet or, if you allow it, from Behest's encrypted copy.", p: "private", icon: EyeOff },
  { t: "Protected by guardians", b: "People you trust approve a release together. None of them can act alone or change where funds go. Availability checks catch a guardian who has gone quiet, and a standby can take their seat.", p: "quorum", icon: ShieldCheck },
  { t: "Check in with one tap", b: "Prove you're here every few months. Behest pays the gas, so a check-in costs you nothing. A delegate or your DAO can check in for you too.", p: "checkin", icon: HeartPulse },
  { t: "Big edits give notice", b: "Changes to heirs, addresses, shares or guardians can wait a notice period before they take effect, and everyone on the plan is told. If someone gets your key, you have time to cancel.", p: "notice", icon: Hourglass },
  { t: "Addresses heirs have proven", b: "Heirs prove they control each address with a signature, and can ask you for a new one while you're around. Only you approve it.", p: "proof", icon: BadgeCheck },
  { t: "Cancel until the last moment", b: "Even after a release is proposed and approved, one tap stops it until the waiting period ends. Delay signers can extend that wait.", p: "quorum", icon: Ban },
  { t: "Heirs pay no gas", b: "Network fees are reserved from the plan, so heirs need nothing but their email or their wallet. Or have transfers start automatically. Money added later goes out in a follow-up round.", p: "split", icon: Coins },
];

/** Feature accordion with the matching panel on the blue gradient. */
export function FeatureExplorer() {
  const [open, setOpen] = useState(0);
  const panel = FEATURES[open]!.p;
  return (
    <div className="grid border-t border-hairline md:grid-cols-2">
      <div className="flex flex-col">
        {FEATURES.map((f, i) => {
          const I = f.icon;
          const on = open === i;
          return (
            <div key={f.t} className="relative border-b border-hairline">
              {on && <motion.span layoutId="feature-rail" aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
              <h3>
                <button
                  onClick={() => setOpen(i)}
                  aria-expanded={on}
                  aria-controls={`feature-${i}`}
                  className={cx("flex w-full items-center gap-3 px-4 py-6 text-left text-lg tracking-[-0.015em] transition-colors sm:px-8", on ? "text-ink" : "text-muted hover:text-ink")}
                >
                  <I aria-hidden className={cx("size-5 shrink-0 transition-colors", on ? "text-signal" : "")} />
                  {f.t}
                </button>
              </h3>
              <div id={`feature-${i}`} className="disclosure-body" data-open={on} inert={!on}>
                <div>
                  <p className="max-w-[520px] px-4 pb-6 pl-12 text-base leading-6 text-muted sm:px-8 sm:pl-16">{f.b}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex min-h-[420px] items-center justify-center bg-gradient-to-b from-[#A9CCFF] via-[#6E9BFF] to-[#2F6BFF] p-6">
        <Swap id={String(open)} className="flex w-full max-w-[416px] flex-col gap-1 rounded-row border border-white/5 bg-[#171717] p-1 text-white">
          {panel === "split" && (
            <>
              <div className="flex flex-col gap-4 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                {HEIRS.map((h) => (
                  <div key={h.n} className="flex items-center justify-between">
                    <span className="flex items-center gap-3">
                      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full text-sm text-[#171717]" style={{ background: h.c }}>
                        {h.i}
                      </span>
                      <span className="flex flex-col">
                        <span className="text-[15px]">{h.n}</span>
                        <span className="font-mono text-xs text-[#A1A1A1]">{h.d}</span>
                      </span>
                    </span>
                    <span className="text-xl">{h.p}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between rounded-tile border border-white/5 bg-[#1F1F1F] p-5 text-sm">
                <span className="text-[#A1A1A1]">Allocated</span>
                <span>100%</span>
              </div>
            </>
          )}
          {panel === "email" && (
            <>
              <div className="flex flex-col gap-2 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="flex items-center justify-between text-xs text-[#A1A1A1]">
                  <span className="flex items-center gap-2">
                    <Mail aria-hidden className="size-3.5" />
                    Behest · to amara@example.com
                  </span>
                  <span>now</span>
                </span>
                <span className="text-[20px] leading-tight tracking-[-0.015em]">Kemi&apos;s plan is ready for you</span>
                <span className="text-sm leading-relaxed text-[#A1A1A1]">What Kemi set aside for you is ready. Sign in with this email address to receive it. You don&apos;t need a wallet.</span>
              </div>
              <div className="flex flex-col gap-3 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="text-sm text-[#A1A1A1]">Code from your inbox</span>
                <div className="flex gap-1.5" aria-label="Sign-in code, for example 4 8 2 9 1 6">
                  {"482916".split("").map((n, i) => (
                    <span key={i} aria-hidden className="flex h-11 flex-1 items-center justify-center rounded-lg bg-white/[0.06] font-mono text-lg">
                      {n}
                    </span>
                  ))}
                </div>
                <span className="flex items-center gap-1.5 text-sm text-[#7DD3A8]">
                  <Check aria-hidden className="size-4" />
                  Signed in as amara@example.com
                </span>
              </div>
              <div className="flex flex-col gap-3 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="text-sm text-[#A1A1A1]">Received · your share of Kemi&apos;s plan</span>
                {[
                  ["BTC", "#FB7A1E", "0.00024 BTC"],
                  ["ETH", "#6366F1", "0.012 ETH"],
                  ["NEAR", "#3B82F6", "0.03 NEAR"],
                ].map(([k, c, amt]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="flex items-center gap-3">
                      <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full text-[9px] font-bold" style={{ background: c }}>
                        {k}
                      </span>
                      <span className="text-[15px]">{amt}</span>
                    </span>
                    <span className="flex items-center gap-1 rounded-full bg-white/[0.08] px-2.5 py-1 text-xs">
                      Send <ArrowUpRight aria-hidden className="size-3" />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {panel === "quorum" && (
            <>
              <div className="flex flex-col gap-3.5 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="text-sm text-[#A1A1A1]">Release proposal · approvals</span>
                <div className="flex gap-2">
                  {["D", "F", "C"].map((g, i) => (
                    <span key={g} className={cx("flex h-11 w-11 items-center justify-center rounded-full text-sm", i < 2 ? "bg-[#2F6BFF]" : "border border-dashed border-[#525252] text-[#A1A1A1]")}>
                      {g}
                    </span>
                  ))}
                </div>
                <span className="text-[28px] tracking-[-0.02em]">2 of 3 approved</span>
              </div>
              <div className="flex flex-col gap-2.5 rounded-tile border border-white/5 bg-[#1F1F1F] p-5 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#A1A1A1]">Waiting period</span>
                  <span>30 days</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#A1A1A1]">You can cancel until</span>
                  <span>it ends</span>
                </div>
              </div>
            </>
          )}
          {panel === "preset" && (
            <>
              <div className="flex flex-col gap-2 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                {[
                  ["Careful", "Slow to start, hard to rush"],
                  ["Balanced", "A sensible middle"],
                  ["Quick", "Heirs receive sooner"],
                ].map(([n, d], i) => (
                  <div key={n} className={cx("flex items-center justify-between rounded-lg px-3 py-2.5", i === 1 ? "bg-[#2F6BFF]" : "bg-white/[0.04]")}>
                    <span className="text-[15px]">{n}</span>
                    <span className={cx("text-xs", i === 1 ? "text-white/80" : "text-[#A1A1A1]")}>{d}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 rounded-tile border border-white/5 bg-[#1F1F1F] p-5 text-sm">
                <span className="text-[#A1A1A1]">In plain words</span>
                <span>If you don&apos;t check in for 90 days, any 2 of 3 guardians may propose a release…</span>
              </div>
            </>
          )}
          {panel === "private" && (
            <>
              <div className="flex flex-col gap-3 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="text-sm text-[#A1A1A1]">On-chain · 2 private heirs</span>
                {["9f3c…e41a", "27b0…c9d5"].map((h) => (
                  <div key={h} className="flex items-center justify-between">
                    <span className="flex items-center gap-3">
                      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-[#525252] text-[#A1A1A1]">
                        <EyeOff className="size-3.5" />
                      </span>
                      <span className="font-mono text-sm">{h}</span>
                    </span>
                    <span className="text-[#A1A1A1]">hidden</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between rounded-tile border border-white/5 bg-[#1F1F1F] p-5 text-sm">
                <span className="text-[#A1A1A1]">Revealed</span>
                <span>only once you&apos;re overdue</span>
              </div>
            </>
          )}
          {panel === "notice" && (
            <>
              <div className="flex flex-col gap-2 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
                <span className="text-sm text-[#A1A1A1]">Waiting change</span>
                <span className="text-[20px] tracking-[-0.015em]">Tobi&apos;s Ethereum address</span>
                <span className="font-mono text-sm text-[#A1A1A1]">takes effect in 6d 23h</span>
              </div>
              <div className="flex items-center justify-between rounded-tile border border-white/5 bg-[#1F1F1F] p-5 text-sm">
                <span className="text-[#A1A1A1]">Guardians and heirs</span>
                <span>notified</span>
              </div>
            </>
          )}
          {panel === "proof" && (
            <div className="flex flex-col gap-3 rounded-tile border border-white/5 bg-[#1F1F1F] p-5">
              <span className="text-sm text-[#A1A1A1]">Amara&apos;s addresses</span>
              {[
                ["NEAR", "amara.near"],
                ["Ethereum", "0x8a1f…92c0"],
                ["Bitcoin", "bc1q…7h2k"],
              ].map(([c, a]) => (
                <div key={c} className="flex items-center justify-between">
                  <span className="flex flex-col">
                    <span className="text-[15px]">{c}</span>
                    <span className="font-mono text-xs text-[#A1A1A1]">{a}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-[#7DD3A8]">
                    <Check aria-hidden className="size-4" />
                    proven
                  </span>
                </div>
              ))}
            </div>
          )}
          {panel === "checkin" && (
            <>
              <div className="flex flex-col items-center gap-3 rounded-tile border border-white/5 bg-[#1F1F1F] p-6">
                <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true">
                  {Array.from({ length: 10 }, (_, i) => (
                    <circle key={i} cx="75" cy="75" r={12 + i * 5} fill="none" stroke="#FFFFFF" strokeOpacity={(0.06 + i * 0.03).toFixed(2)} />
                  ))}
                  <circle cx="75" cy="75" r="68" fill="none" stroke="#2E2E2E" strokeWidth="8" />
                  <circle cx="75" cy="75" r="68" fill="none" stroke="#2F6BFF" strokeWidth="8" strokeLinecap="round" strokeDasharray="85 427" transform="rotate(-90 75 75)" />
                </svg>
                <span className="text-[28px] tracking-[-0.02em]">18 days left</span>
              </div>
              <div className="flex items-center gap-3 px-5 py-4">
                <span className="h-2 w-2 rounded-full bg-[#2F6BFF]" aria-hidden="true" />
                <span className="font-semibold tracking-[-0.01em]">One tap to check in</span>
              </div>
            </>
          )}
        </Swap>
      </div>
    </div>
  );
}
