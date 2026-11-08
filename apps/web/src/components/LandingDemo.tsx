"use client";
// Landing-page demo: an example plan in the dashboard frame. Tabs and the
// check-in button work locally; nothing touches the chain.
import { useState } from "react";
import { Mark } from "./chrome";
import { cx } from "./ui";

const TABS = [
  ["plan", "Plan"],
  ["heirs", "Heirs"],
  ["guardians", "Guardians"],
  ["activity", "Activity"],
] as const;
type Tab = (typeof TABS)[number][0];

const ASSETS = [
  { k: "BTC", c: "#FB7A1E", name: "Bitcoin", amt: "0.0004 BTC · testnet4 vault", tag: "Fees reserved" },
  { k: "ETH", c: "#6366F1", name: "Ethereum", amt: "0.02 ETH · 0.01 WETH · Sepolia vault", tag: "Fees reserved" },
  { k: "NEAR", c: "#171717", name: "NEAR", amt: "0.05 NEAR · 0.01 wNEAR in escrow", tag: "Gas sponsored" },
];
const HEIRS = [
  { i: "A", n: "Amara", d: "ETH · 0x71C7…976F", p: "60%", c: "#A9CCFF" },
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
  const days = checkedIn ? 90 : 18;
  const C = 2 * Math.PI * 23;
  return (
    <div className="grid overflow-hidden rounded-[20px] bg-[#262626] text-left md:grid-cols-[232px_minmax(0,1fr)]">
      <div className="flex flex-col text-[#D4D4D4]">
        <div className="flex items-center gap-2.5 border-b border-white/10 px-6 py-5 text-white">
          <Mark size={22} light />
          <span className="font-semibold">behest</span>
        </div>
        <nav aria-label="Demo" className="flex gap-0.5 overflow-x-auto p-3 md:flex-col">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              aria-current={tab === k ? "page" : undefined}
              className={cx("h-11 shrink-0 rounded-tile px-3 text-left text-[15px]", tab === k ? "bg-white/[0.06] text-white" : "hover:bg-white/[0.04]")}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="m-2 min-h-[520px] rounded-tile bg-[#FEFEFE] p-5 text-[#171717] sm:p-8 md:ml-0">
        <div className="mx-auto flex max-w-[704px] flex-col gap-8">
          {tab === "plan" && (
            <>
              <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-base text-[#737373]">Example plan · testnet</span>
                  <span className="text-[40px] leading-none tracking-[-0.03em]">3 chains, 2 heirs</span>
                </div>
                <button
                  onClick={() => setCheckedIn(true)}
                  className={cx("h-10 rounded-[10px] px-3.5 text-sm", checkedIn ? "bg-[rgba(47,107,255,.14)] text-[#1D3FB8]" : "bg-[#171717] text-white")}
                >
                  {checkedIn ? "Checked in" : "Check in"}
                </button>
              </header>
              <div className="rounded-row border border-[#E5E5E5] bg-[#FAFAFA] px-1 pb-1">
                <div className="px-6 py-3 text-sm font-semibold">Balances</div>
                <ul className="overflow-hidden rounded-tile border border-[#E5E5E5] bg-white">
                  {ASSETS.map((a, i) => (
                    <li key={a.k} className={cx("grid items-center gap-3 px-5 py-4 sm:grid-cols-[1.4fr_1fr] sm:px-6", i > 0 && "border-t border-[#E5E5E5]")}>
                      <span className="flex items-center gap-3">
                        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: a.c }}>
                          {a.k}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[15px]">{a.name}</span>
                          <span className="text-sm text-[#737373]">{a.amt}</span>
                        </span>
                      </span>
                      <span className="inline-flex h-6 items-center gap-1 justify-self-start rounded-tag bg-[rgba(34,197,94,.14)] pl-1.5 pr-2 text-[13px] text-[#15803D] sm:justify-self-end">
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                        {a.tag}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-4 rounded-row border border-[#E5E5E5] p-5">
                  <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
                    <circle cx="28" cy="28" r="23" fill="none" stroke="#EDEDED" strokeWidth="6" />
                    <circle cx="28" cy="28" r="23" fill="none" stroke="#2F6BFF" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${((C * days) / 90).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 28 28)" className="transition-[stroke-dasharray] duration-500" />
                  </svg>
                  <div className="flex flex-col">
                    <span className="text-[22px] tracking-[-0.02em]">{days} days</span>
                    <span className="text-sm text-[#737373]">until the next check-in</span>
                  </div>
                </div>
                <div className="flex flex-col justify-center rounded-row border border-[#E5E5E5] p-5">
                  <span className="text-[22px] tracking-[-0.02em]">2 of 3</span>
                  <span className="text-sm text-[#737373]">guardians to release</span>
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
              <ul className="overflow-hidden rounded-tile border border-[#E5E5E5]">
                {HEIRS.map((h, i) => (
                  <li key={h.n} className={cx("grid items-center gap-2 px-5 py-4 sm:grid-cols-[1fr_1.3fr_auto] sm:px-6", i > 0 && "border-t border-[#E5E5E5]")}>
                    <span className="flex items-center gap-3">
                      <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full text-sm" style={{ background: h.c }}>
                        {h.i}
                      </span>
                      {h.n}
                    </span>
                    <span className="font-mono text-[13px] text-[#737373]">{h.d}</span>
                    <span className="text-lg sm:text-right">{h.p}</span>
                  </li>
                ))}
              </ul>
              <span className="text-sm text-[#737373]">Destinations are fixed. Nobody else can change them.</span>
            </>
          )}
          {tab === "guardians" && (
            <>
              <DemoHead k="Guardians" t="Any 2 of 3" />
              <ul className="overflow-hidden rounded-tile border border-[#E5E5E5]">
                {GUARDIANS.map((g, i) => (
                  <li key={g} className={cx("flex items-center justify-between px-6 py-4", i > 0 && "border-t border-[#E5E5E5]")}>
                    <span>{g}</span>
                    <span className="inline-flex h-6 items-center rounded-tag bg-[rgba(34,197,94,.14)] px-2 text-[13px] text-[#15803D]">Standing by</span>
                  </li>
                ))}
              </ul>
              <span className="text-sm text-[#737373]">They can start a release if you stop checking in. They can never redirect funds.</span>
            </>
          )}
          {tab === "activity" && (
            <>
              <DemoHead k="Activity" t="Recent" />
              <ul className="overflow-hidden rounded-tile border border-[#E5E5E5]">
                {ACTIVITY.map(([t, d, w], i) => (
                  <li key={t} className={cx("grid gap-1 px-6 py-4 sm:grid-cols-[1.2fr_1.2fr_auto] sm:items-center", i > 0 && "border-t border-[#E5E5E5]")}>
                    <span>{t}</span>
                    <span className="text-sm text-[#737373]">{d}</span>
                    <span className="text-sm text-[#737373] sm:text-right">{w}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DemoHead({ k, t }: { k: string; t: string }) {
  return (
    <header className="flex flex-col gap-1">
      <span className="text-base text-[#737373]">{k}</span>
      <span className="text-[40px] leading-none tracking-[-0.03em]">{t}</span>
    </header>
  );
}

const FEATURES = [
  { t: "Split across your heirs", b: "Give each person a share and a fixed address on the chain they use: NEAR, Ethereum or Bitcoin. Add fixed amounts, a remainder rule, alternates and a fallback.", p: "split" },
  { t: "Protected by guardians", b: "People you trust approve a release together. None of them can act alone, and none of them can change where funds go.", p: "quorum" },
  { t: "Check in with one tap", b: "Prove you're here every few months. Behest pays the gas, so a check-in costs you nothing.", p: "checkin" },
  { t: "Cancel until the last moment", b: "Even after a release is proposed and approved, one tap stops it until the waiting period ends. Delay signers can extend that wait.", p: "quorum" },
  { t: "Heirs pay no gas", b: "Network fees are reserved from the plan, so heirs need nothing but their wallet. Or have transfers start automatically.", p: "split" },
] as const;

/** Feature accordion with the matching panel on the blue gradient. */
export function FeatureExplorer() {
  const [open, setOpen] = useState(0);
  const panel = FEATURES[open]!.p;
  return (
    <div className="grid border-t border-hairline md:grid-cols-2">
      <div className="flex flex-col">
        {FEATURES.map((f, i) => (
          <div key={f.t} className="border-b border-hairline">
            <h3>
              <button
                onClick={() => setOpen(i)}
                aria-expanded={open === i}
                className={cx("w-full px-4 py-6 text-left text-lg tracking-[-0.015em] sm:px-8", open === i ? "text-ink" : "text-muted hover:text-ink")}
              >
                {f.t}
              </button>
            </h3>
            {open === i && <p className="max-w-[520px] px-4 pb-6 text-base leading-6 text-muted sm:px-8">{f.b}</p>}
          </div>
        ))}
      </div>
      <div className="flex min-h-[420px] items-center justify-center bg-gradient-to-b from-[#A9CCFF] via-[#6E9BFF] to-[#2F6BFF] p-6">
        <div className="flex w-full max-w-[416px] flex-col gap-1 rounded-row border border-white/5 bg-[#171717] p-1 text-white">
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
        </div>
      </div>
    </div>
  );
}
