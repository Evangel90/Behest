"use client";
// Plan creation and editing as a guided wizard: timing, guardians, heirs,
// funding, then a plain-language review before anything is signed.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Coins, Divide, Gift, LoaderCircle, Pencil, Plus, ScrollText, ShieldCheck, Timer, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { Disclosure, Field, Segmented, Term } from "@/components/interactive";
import { HeirList, ShareBar } from "@/components/PlanParts";
import { Swap } from "@/components/motion";
import { SignInDialog } from "@/components/SignIn";
import { TierNeeded } from "@/components/Tiers";
import { Button, ButtonLink, Card, EmptyState, Notice, SectionTitle, Skeleton, cx, inputClass } from "@/components/ui";
import { getBtcDestinations, getConfig, getPlan, getSponsorship, sponsorshipAvailable, view as viewCall, type Sponsorship } from "@/lib/contract";
import { humanError } from "@/lib/hooks";
import { describePlan, duration, parseNear, percent, shortName, validateDraft } from "@/lib/plan";
import { SponsorRefused, useSession } from "@/lib/session";
import { features, formatUsd, reasonFor, requiredTier, useTier, useTierConfig } from "@/lib/tiers";
import type { PlanInput, PlanView, ReleaseOptions, ReleaseRules } from "@/lib/types";
import {
  WIZARD_STEPS,
  fromMs,
  guardianErrors,
  heirErrors,
  sharesTotal,
  splitEvenly,
  timingErrors,
  toMs,
  type FieldErrors,
  type HeirDraft,
  type TimerDraft,
  type Unit,
  type WizardStep,
} from "@/lib/wizard";

const STEP_META: Record<WizardStep, { label: string; icon: LucideIcon; title: string; lede: string }> = {
  timing: { label: "Timing", icon: Timer, title: "How often will you check in?", lede: "Miss a check-in and the grace period, and your guardians may start a release. You can cancel until the waiting period ends." },
  guardians: { label: "Guardians", icon: ShieldCheck, title: "Who watches over the plan?", lede: "People you trust to notice you're unreachable. They can only release the plan exactly as written, never change where funds go." },
  heirs: { label: "Heirs", icon: Gift, title: "Who receives what?", lede: "Give each person a share and the addresses where it should arrive. Nobody else can change these." },
  funding: { label: "Funding", icon: Coins, title: "What goes in now?", lede: "Put some NEAR into the plan. Ethereum and Bitcoin vaults appear on your plan page once it's saved." },
  review: { label: "Review", icon: ScrollText, title: "Read it once more.", lede: "This is exactly what you're signing. Nothing is sent until you confirm in your wallet." },
};

const DRAFT_KEY = "behest.setup-draft";
interface Draft {
  checkIn: TimerDraft;
  grace: TimerDraft;
  waiting: TimerDraft;
  guardians: string[];
  quorum: string;
  heirs: HeirDraft[];
  deposit: string;
}
const DEMO_DRAFT: Draft = {
  checkIn: { n: "5", unit: "minutes" },
  grace: { n: "0", unit: "minutes" },
  waiting: { n: "5", unit: "minutes" },
  guardians: ["", ""],
  quorum: "2",
  heirs: [{ account: "", pct: "100", near: "", eth: "" }],
  deposit: "0.5",
};

export default function SetupPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const router = useRouter();
  const asked = useSearchParams().get("edit") === "1";
  const { session, ready } = useSession();
  const [demo, setDemo] = useState(true);
  const [existing, setExisting] = useState<PlanView | null | undefined>(undefined);
  const [d, setD] = useState<Draft>(DEMO_DRAFT);
  const [step, setStep] = useState<WizardStep>("timing");
  const [dir, setDir] = useState(1);
  const [tried, setTried] = useState<Partial<Record<WizardStep, boolean>>>({});
  const [phase, setPhase] = useState<"idle" | "plan" | "deposit" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);
  const [ack, setAck] = useState(false);
  const [spons, setSpons] = useState<Sponsorship | null | undefined>(undefined);
  const [paidBy, setPaidBy] = useState<"behest" | "you">("you");
  // D25: what the saved plan already has beside the policy (rules, options,
  // Bitcoin destinations, token escrow) counts toward the tier it needs.
  const [extras, setExtras] = useState<{ rules: ReleaseRules | null; options: ReleaseOptions | null; btc: number; tokens: boolean }>({ rules: null, options: null, btc: 0, tokens: false });
  const tierCfg = useTierConfig();
  const { tier, reload: reloadTier } = useTier(session?.accountId);
  const top = useRef<HTMLDivElement>(null);
  // An owner who already has a plan always edits it (the contract keeps one plan per account).
  const editing = asked || !!existing;
  const steps = WIZARD_STEPS.filter((s) => !(editing && s === "funding"));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  useEffect(() => void getConfig().then((c) => setDemo(c.demo_timers)).catch(() => {}), []);
  useEffect(() => {
    if (!session) return;
    getPlan(session.accountId)
      .then((v) => {
        setExisting(v);
        if (v) {
          const p = v.plan.policy;
          setD({
            checkIn: fromMs(p.check_in_interval_ms),
            grace: fromMs(p.grace_ms),
            waiting: fromMs(p.waiting_period_ms),
            guardians: p.guardians,
            quorum: String(p.quorum),
            heirs: p.heirs.map((h) => ({ account: h.account_id, pct: String(h.share_bps / 100), near: h.near_destination === h.account_id ? "" : (h.near_destination ?? ""), eth: h.eth_destination ?? "" })),
            deposit: "0",
          });
        } else {
          try {
            const saved = sessionStorage.getItem(DRAFT_KEY);
            if (saved) setD({ ...DEMO_DRAFT, ...(JSON.parse(saved) as Draft) });
          } catch {}
        }
      })
      .catch(() => setExisting(null));
  }, [session]);
  useEffect(() => {
    if (!existing) return;
    const owner = existing.plan.owner;
    Promise.all([
      viewCall<ReleaseRules | null>("get_release_rules", { owner }).catch(() => null),
      viewCall<ReleaseOptions | null>("get_release_options", { owner }).catch(() => null),
      getBtcDestinations(owner).catch(() => []),
    ]).then(([rules, options, btc]) => setExtras({ rules, options, btc: btc.length, tokens: (existing.ft_escrow ?? []).some((t) => BigInt(t.amount) > 0n) }));
  }, [existing]);
  // D24: can Behest's sponsor pool cover this owner's storage?
  useEffect(() => {
    if (!session) return;
    setSpons(undefined);
    getSponsorship(session.accountId)
      .then(setSpons)
      .catch(() => setSpons(null));
  }, [session]);
  // Keep an unsent new-plan draft for this tab.
  useEffect(() => {
    if (existing !== null) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {}
  }, [d, existing]);

  const owner = session?.accountId ?? "";
  const plan: PlanInput = useMemo(
    () => ({
      check_in_interval_ms: toMs(d.checkIn),
      grace_ms: toMs(d.grace),
      waiting_period_ms: toMs(d.waiting),
      guardians: d.guardians.map((g) => g.trim().toLowerCase()).filter(Boolean),
      quorum: Number(d.quorum) || 0,
      heirs: d.heirs.map((h) => ({
        account_id: h.account.trim().toLowerCase(),
        share_bps: Math.round(Number(h.pct) * 100) || 0,
        near_destination: (h.near.trim() || h.account.trim()).toLowerCase() || null,
        eth_destination: h.eth.trim() ? h.eth.trim().toLowerCase() : null,
      })),
    }),
    [d],
  );
  // Ethereum wallets can't attach NEAR: no deposit, and storage must be sponsored.
  const evm = session?.kind === "evm";
  const sponsored = !!session?.canSponsorStorage && sponsorshipAvailable(spons ?? null, !editing);
  const evmBlocked = evm && spons !== undefined && !sponsored;
  let depositYocto: bigint | null = null;
  try {
    depositYocto = evm ? 0n : parseNear(d.deposit || "0");
  } catch {}

  const errs: Record<WizardStep, FieldErrors> = {
    timing: timingErrors(d, demo),
    guardians: guardianErrors(d.guardians, d.quorum, owner),
    heirs: heirErrors(d.heirs, owner, d.guardians),
    funding: depositYocto === null ? { deposit: "Not a valid NEAR amount." } : {},
    review: {},
  };
  const show = (s: WizardStep) => (tried[s] ? errs[s] : {});
  const stepOk = (s: WizardStep) => Object.keys(errs[s]).length === 0;
  const finalErrors = session ? validateDraft(plan, session.accountId) : [];
  // D25: the tier this draft needs, and whether the owner has it (or already uses it).
  const tiersOn = !!tierCfg?.fee_token;
  const draftFeatures = features(plan, extras.rules, extras.options, extras.btc, extras.tokens);
  const needTier = tierCfg && tiersOn ? requiredTier(tierCfg, draftFeatures) : 0;
  const allowance = tier ? Math.max(tier.tier, editing ? tier.required : 0) : 0;
  const tierBlocked = tiersOn && (!tier || needTier > allowance);
  const idx = steps.indexOf(step);

  const go = (to: WizardStep) => {
    setDir(steps.indexOf(to) >= idx ? 1 : -1);
    setStep(to);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const next = (e?: FormEvent) => {
    e?.preventDefault();
    setTried((t) => ({ ...t, [step]: true }));
    if (!stepOk(step)) {
      requestAnimationFrame(() => (document.querySelector("[aria-invalid=true]") as HTMLElement | null)?.focus());
      return;
    }
    const n = steps[idx + 1];
    if (n) go(n);
  };
  const reachable = (s: WizardStep) => steps.slice(0, steps.indexOf(s)).every(stepOk);

  async function submit() {
    if (!session) return;
    setError(null);
    try {
      setPhase("plan");
      let saved = false;
      // D24: no deposit, Behest's sponsor pool pays the storage. If the relayer
      // or the pool says no, a NEAR account pays as before (nothing changed yet).
      if (sponsored || evm) {
        try {
          await session.call("set_plan", { plan }, { sponsor: true, summary: editing ? "Update your inheritance plan" : "Create your inheritance plan" });
          saved = true;
          setPaidBy("behest");
        } catch (e) {
          if (evm || !(e instanceof SponsorRefused)) throw e;
        }
      }
      // Storage deposit; the contract refunds whatever it doesn't use.
      if (!saved) {
        await session.call("set_plan", { plan }, { deposit: 100_000_000_000_000_000_000_000n });
        setPaidBy("you");
      }
      if (!editing && depositYocto && depositYocto > 0n) {
        setPhase("deposit");
        await session.call("deposit", { owner: session.accountId }, { deposit: depositYocto });
      }
      setPhase("done");
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {}
      setTimeout(() => router.push(`/plan/${encodeURIComponent(session.accountId)}`), 1400);
    } catch (e) {
      setError(humanError(e));
      setPhase("idle");
    }
  }

  if (ready && !session) {
    return (
      <AppShell>
        <EmptyState icon={UserRound} title="Sign in to create a plan" body="The account you sign in with becomes the plan owner. No wallet? Try every role with test personas.">
          <Button variant="primary" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
          <ButtonLink href="/try" variant="outline">
            Try as a test persona
          </ButtonLink>
        </EmptyState>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </AppShell>
    );
  }
  if (!ready || existing === undefined) {
    return (
      <AppShell>
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-14 w-full rounded-tile" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      </AppShell>
    );
  }

  if (phase === "done") {
    return (
      <AppShell narrow>
        <div className="flex flex-col items-center gap-5 py-16 text-center">
          <span className="flex size-20 animate-pop items-center justify-center rounded-full bg-ok-bg text-ok">
            <CircleCheck aria-hidden className="size-10" />
          </span>
          <h1 className="text-[clamp(32px,6vw,48px)] font-medium leading-none tracking-[-0.04em]">{editing ? "Plan updated." : "Your plan is live."}</h1>
          <p role="status" className="max-w-[420px] text-lg text-muted">
            Taking you to it now. {paidBy === "behest" ? "Behest covered the plan's storage. " : ""}Remember to check in every {duration(plan.check_in_interval_ms)}.
          </p>
          <ButtonLink href={`/plan/${encodeURIComponent(owner)}`} variant="primary" iconRight={ArrowRight}>
            Open your plan
          </ButtonLink>
        </div>
      </AppShell>
    );
  }

  const meta = STEP_META[step];
  const signing = phase !== "idle";
  return (
    <AppShell mainClassName="max-w-[1180px]">
      <div ref={top} className="scroll-mt-24 flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted">{editing ? "Edit your plan" : "Create a plan"}</span>
        <h1 className="text-[clamp(32px,5vw,52px)] font-medium leading-[0.95] tracking-[-0.045em]">{meta.title}</h1>
        <p className="max-w-[680px] text-[17px] leading-relaxed text-muted">{evm && step === "funding" ? "Your plan's Ethereum and Bitcoin vaults appear on your plan page once it's saved. Fund them by sending to their addresses." : meta.lede}</p>
      </div>

      <Stepper steps={steps} current={step} ok={stepOk} reachable={reachable} onGo={go} />

      {editing && existing && step === steps[0] && <Notice tone="info">Your current plan is filled in. Saving makes a new version, which counts as a check-in; any open release must be cancelled first.</Notice>}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={step === "review" ? (e) => e.preventDefault() : next} noValidate className="flex min-w-0 flex-col gap-4">
          <Swap id={step} dir={dir} className="flex flex-col gap-4">
            {step === "timing" && <TimingStep d={d} set={set} demo={demo} errors={show("timing")} />}
            {step === "guardians" && <GuardianStep d={d} set={set} errors={show("guardians")} />}
            {step === "heirs" && <HeirStep d={d} set={set} errors={show("heirs")} />}
            {step === "funding" && <FundingStep d={d} set={set} errors={show("funding")} evm={evm} sponsored={sponsored} />}
            {step === "review" && session && (
              <ReviewStep plan={plan} d={d} owner={owner} editing={editing} depositYocto={depositYocto} onEdit={go} finalErrors={finalErrors} ack={ack} setAck={setAck} evm={evm} sponsored={sponsored} spons={spons} />
            )}
          </Swap>

          {step === "review" && tiersOn && tierCfg && tier && needTier > allowance && (
            <TierNeeded cfg={tierCfg} owner={owner} need={needTier} tier={tier} onPaid={reloadTier} reason={reasonFor(tierCfg, allowance, draftFeatures)} />
          )}
          {error && (
            <Notice tone="error" title="Nothing was saved">
              {error}
            </Notice>
          )}
          {signing && <SigningProgress phase={phase} withDeposit={!editing && !!depositYocto && depositYocto > 0n} evm={evm} />}

          <div className="sticky bottom-[calc(68px+env(safe-area-inset-bottom))] z-10 -mx-4 flex items-center justify-between gap-2 border-t border-line bg-paper/90 px-4 py-3 backdrop-blur-md sm:-mx-0 sm:rounded-row sm:border sm:px-3 lg:bottom-2">
            <Button type="button" variant="ghost" icon={ArrowLeft} disabled={idx === 0 || signing} onClick={() => go(steps[idx - 1]!)}>
              Back
            </Button>
            <span className="hidden text-sm text-muted sm:block">
              Step {idx + 1} of {steps.length}
            </span>
            {step !== "review" ? (
              <Button type="submit" variant="ink" iconRight={ArrowRight}>
                Continue
              </Button>
            ) : (
              <Button type="button" variant="primary" icon={Check} loading={signing} disabled={finalErrors.length > 0 || !ack || tierBlocked || (!editing && depositYocto === null) || evmBlocked || (evm && spons === undefined)} onClick={submit}>
                {editing ? "Sign and update" : "Sign and create"}
              </Button>
            )}
          </div>
        </form>

        <aside className="hidden flex-col gap-3 lg:sticky lg:top-2 lg:flex">
          <Card className="flex flex-col gap-4">
            <span className="text-sm font-semibold text-muted">Your plan so far</span>
            <p className="text-[15px] leading-relaxed">{session ? describePlan(plan) : ""}</p>
            <Consequences plan={plan} />
            {tiersOn && tierCfg && (
              <span className="flex items-center justify-between gap-2 rounded-row bg-subtle px-3 py-2 text-sm">
                <span>
                  <span className="font-semibold">{tierCfg.tiers[needTier]!.name}</span> tier
                </span>
                <span className="text-muted">{needTier <= allowance ? (tier && tier.tier > 0 ? "paid" : "free") : `${formatUsd(tierCfg.tiers[needTier]!.price, tierCfg.fee_decimals)} once`}</span>
              </span>
            )}
            {plan.heirs.length > 0 && <ShareBar heirs={plan.heirs} />}
          </Card>
          <p className="px-2 text-xs leading-relaxed text-muted">Your draft stays in this tab until you sign. Nothing is sent before the review step.</p>
        </aside>
      </div>
    </AppShell>
  );
}

// ------------------------------------------------------------------ stepper

function Stepper({ steps, current, ok, reachable, onGo }: { steps: WizardStep[]; current: WizardStep; ok: (s: WizardStep) => boolean; reachable: (s: WizardStep) => boolean; onGo: (s: WizardStep) => void }) {
  const at = steps.indexOf(current);
  return (
    <nav aria-label="Steps">
      <div className="mb-2 flex items-center justify-between text-sm sm:hidden">
        <span className="font-semibold">
          Step {at + 1} of {steps.length} · {STEP_META[current].label}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line sm:hidden">
        <div className="h-full rounded-full bg-signal transition-[width] duration-500 ease-ledger" style={{ width: `${((at + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className="hidden items-center gap-2 sm:flex">
        {steps.map((s, i) => {
          const I = STEP_META[s].icon;
          const done = i < at && ok(s);
          const on = s === current;
          const can = reachable(s);
          return (
            <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
              <button
                type="button"
                disabled={!can && !on}
                onClick={() => onGo(s)}
                aria-current={on ? "step" : undefined}
                className={cx("flex min-h-11 min-w-0 items-center gap-2 rounded-full pr-3 text-sm transition-colors", on ? "font-semibold text-ink" : can ? "text-ink hover:bg-subtle" : "text-muted")}
              >
                <span
                  className={cx(
                    "flex size-9 shrink-0 items-center justify-center rounded-full transition-all duration-300 ease-ledger",
                    on ? "bg-ink text-ink-contrast" : done ? "bg-signal text-white" : "bg-card text-muted ring-1 ring-line-strong",
                  )}
                >
                  {done ? <Check aria-hidden className="size-4 animate-pop" /> : <I aria-hidden className="size-4" />}
                </span>
                <span className="truncate">{STEP_META[s].label}</span>
              </button>
              {i < steps.length - 1 && <span aria-hidden className={cx("h-0.5 min-w-3 flex-1 rounded-full transition-colors duration-500", i < at ? "bg-signal" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ------------------------------------------------------------------- steps

type SetFn = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

function TimerField({ label, tip, value, onChange, units, error, hint }: { label: string; tip: Parameters<typeof Field>[0]["tip"]; value: TimerDraft; onChange: (t: TimerDraft) => void; units: Unit[]; error?: string; hint: string }) {
  return (
    <Field label={label} tip={tip} hint={hint} error={error}>
      {(p) => (
        <div className="flex flex-wrap items-center gap-2">
          <input {...p} className={`${inputClass} w-28 text-lg font-semibold`} inputMode="decimal" value={value.n} onChange={(e) => onChange({ ...value, n: e.target.value })} />
          <Segmented label={`${label} unit`} size="sm" value={value.unit} onChange={(u) => onChange({ ...value, unit: u })} options={units.map((u) => ({ value: u, label: u }))} />
        </div>
      )}
    </Field>
  );
}

function TimingStep({ d, set, demo, errors }: { d: Draft; set: SetFn; demo: boolean; errors: FieldErrors }) {
  const units: Unit[] = demo ? ["minutes", "hours", "days"] : ["days"];
  const presets: { label: string; ci: TimerDraft; gr: TimerDraft; wa: TimerDraft }[] = demo
    ? [
        { label: "Quick demo · 2 min", ci: { n: "2", unit: "minutes" }, gr: { n: "0", unit: "minutes" }, wa: { n: "2", unit: "minutes" } },
        { label: "Relaxed demo · 10 min", ci: { n: "10", unit: "minutes" }, gr: { n: "2", unit: "minutes" }, wa: { n: "5", unit: "minutes" } },
        { label: "Real-world · 90 days", ci: { n: "90", unit: "days" }, gr: { n: "7", unit: "days" }, wa: { n: "30", unit: "days" } },
      ]
    : [
        { label: "Every 90 days", ci: { n: "90", unit: "days" }, gr: { n: "7", unit: "days" }, wa: { n: "30", unit: "days" } },
        { label: "Every 6 months", ci: { n: "180", unit: "days" }, gr: { n: "14", unit: "days" }, wa: { n: "30", unit: "days" } },
        { label: "Once a year", ci: { n: "365", unit: "days" }, gr: { n: "30", unit: "days" }, wa: { n: "60", unit: "days" } },
      ];
  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
        {presets.map((p) => {
          const on = p.ci.n === d.checkIn.n && p.ci.unit === d.checkIn.unit && p.gr.n === d.grace.n && p.wa.n === d.waiting.n && p.wa.unit === d.waiting.unit;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={on}
              onClick={() => {
                set("checkIn", p.ci);
                set("grace", p.gr);
                set("waiting", p.wa);
              }}
              className={cx("min-h-11 rounded-full border px-4 text-sm transition-colors", on ? "border-signal bg-s-approved font-semibold text-[var(--s-approved-fg)]" : "border-line bg-card hover:bg-subtle")}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <Card className="flex flex-col gap-6">
        <TimerField label="Check in every" tip="checkIn" value={d.checkIn} onChange={(t) => set("checkIn", t)} units={units} error={errors.checkIn} hint="One tap, gas paid by Behest. Miss it and the grace period starts." />
        <TimerField label="Then allow grace of" tip="grace" value={d.grace} onChange={(t) => set("grace", t)} units={units} error={errors.grace} hint={demo ? "Extra time before guardians can act. Zero is fine for a demo." : "Extra time before guardians can act: 1 to 30 days."} />
        <TimerField label="Waiting period" tip="waiting" value={d.waiting} onChange={(t) => set("waiting", t)} units={units} error={errors.waiting} hint="After guardians approve. You can still cancel during it." />
      </Card>
      {demo && <p className="text-sm text-muted">This is a demo-timer deployment: minutes are allowed so you can watch a release end to end.</p>}
    </>
  );
}

function GuardianStep({ d, set, errors }: { d: Draft; set: SetFn; errors: FieldErrors }) {
  const filled = d.guardians.filter((g) => g.trim()).length;
  const max = Math.max(1, filled);
  const q = Math.min(Number(d.quorum) || 1, max);
  return (
    <>
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={ShieldCheck} title={<Term k="guardian">Guardians</Term>} sub="NEAR accounts. Two or three people who know you well is typical." />
        <ul className="flex flex-col gap-3">
          {d.guardians.map((g, i) => (
            <li key={i} className="flex animate-fade-up items-start gap-2">
              <Field label={`Guardian ${i + 1}`} error={errors[`guardian.${i}`]} className="flex-1">
                {(p) => (
                  <input
                    {...p}
                    className={inputClass}
                    placeholder={["dayo.testnet", "funmi.testnet", "chidi.testnet"][i] ?? "guardian.testnet"}
                    value={g}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(e) => set("guardians", d.guardians.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                )}
              </Field>
              {d.guardians.length > 1 && (
                <button type="button" aria-label={`Remove guardian ${i + 1}`} onClick={() => set("guardians", d.guardians.filter((_, j) => j !== i))} className="mt-[30px] flex size-12 shrink-0 items-center justify-center rounded-tile text-muted hover:bg-subtle hover:text-ink">
                  <Trash2 aria-hidden className="size-[18px]" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <Button type="button" variant="outline" size="sm" icon={Plus} className="self-start" onClick={() => set("guardians", [...d.guardians, ""])}>
          Add guardian
        </Button>
        {errors.guardians && <span className="text-[13px] font-semibold text-error">{errors.guardians}</span>}
      </Card>
      <Card className="flex flex-col gap-4">
        <SectionTitle title={<Term k="quorum">Approvals needed</Term>} sub="How many guardians must agree before a release goes ahead." />
        <Segmented
          label="Approvals needed"
          value={String(q)}
          onChange={(v) => set("quorum", v)}
          options={Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: `${i + 1}` }))}
        />
        <p className="text-[15px]">
          Any <strong>{q}</strong> of <strong>{filled || "your"}</strong> guardian{filled === 1 ? "" : "s"} can release the plan. {q === 1 && filled > 1 ? "One person acting alone is convenient but less safe." : ""}
        </p>
        {errors.quorum && <span className="text-[13px] font-semibold text-error">{errors.quorum}</span>}
      </Card>
    </>
  );
}

function HeirStep({ d, set, errors }: { d: Draft; set: SetFn; errors: FieldErrors }) {
  const total = sharesTotal(d.heirs);
  const upd = (i: number, x: Partial<HeirDraft>) => set("heirs", d.heirs.map((h, j) => (j === i ? { ...h, ...x } : h)));
  return (
    <>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cx("text-sm font-semibold", total === 10_000 ? "text-ok" : "text-warn")}>{total === 10_000 ? "100% allocated" : total < 10_000 ? `${percent(total)} allocated · ${percent(10_000 - total)} left` : `${percent(total)} allocated · ${percent(total - 10_000)} too much`}</span>
          <Button type="button" variant="subtle" size="sm" icon={Divide} onClick={() => set("heirs", d.heirs.map((h, i) => ({ ...h, pct: splitEvenly(d.heirs.length)[i]! })))}>
            Split evenly
          </Button>
        </div>
        <ShareBar heirs={d.heirs.map((h, i) => ({ account_id: `${i}`, share_bps: Math.round(Number(h.pct) * 100) || 0 }))} />
        {errors.shares && <span className="text-[13px] font-semibold text-error">{errors.shares}</span>}
      </Card>
      <ul className="flex flex-col gap-3">
        {d.heirs.map((h, i) => (
          <li key={i} className="animate-fade-up">
            <Card className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{h.account.trim() ? shortName(h.account.trim()) : `Heir ${i + 1}`}</span>
                {d.heirs.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" icon={Trash2} onClick={() => set("heirs", d.heirs.filter((_, j) => j !== i))} aria-label={`Remove heir ${i + 1}`}>
                    Remove
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                <Field label="NEAR account" error={errors[`heir.${i}.account`]} hint="Their sign-in, and where NEAR goes unless you set another account below.">
                  {(p) => <input {...p} className={inputClass} placeholder="amara.testnet" value={h.account} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { account: e.target.value })} />}
                </Field>
                <Field label="Share" error={errors[`heir.${i}.pct`]}>
                  {(p) => (
                    <div className="flex min-h-12 items-center rounded-row bg-subtle px-4 focus-within:ring-2 focus-within:ring-signal/40">
                      <input {...p} className="min-w-0 flex-1 bg-transparent text-2xl font-bold outline-none" inputMode="decimal" value={h.pct} onChange={(e) => upd(i, { pct: e.target.value })} />
                      <span className="text-lg font-medium text-muted">%</span>
                    </div>
                  )}
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="NEAR goes to" optional error={errors[`heir.${i}.near`]} hint={h.account.trim() ? `Defaults to ${h.account.trim()}.` : "Defaults to the heir account."}>
                  {(p) => <input {...p} className={inputClass} placeholder={h.account || "amara.testnet"} value={h.near} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { near: e.target.value })} />}
                </Field>
                <Field label="Ethereum address" optional error={errors[`heir.${i}.eth`]} hint="For Sepolia ETH and tokens. Leave empty for none.">
                  {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} placeholder="0x…" value={h.eth} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { eth: e.target.value })} />}
                </Field>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" icon={Plus} className="self-start" onClick={() => set("heirs", [...d.heirs, { account: "", pct: "0", near: "", eth: "" }])}>
        Add heir
      </Button>
      <p className="text-sm text-muted">Bitcoin addresses are added on your plan page once the Bitcoin vault is set up.</p>
    </>
  );
}

function FundingStep({ d, set, errors, evm, sponsored }: { d: Draft; set: SetFn; errors: FieldErrors; evm: boolean; sponsored: boolean }) {
  if (evm)
    return (
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={Coins} title="Nothing to send now" sub="An Ethereum wallet can't attach NEAR, so this plan starts without a NEAR balance." />
        <ul className="flex flex-col gap-2 text-[15px] leading-relaxed">
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>Send Sepolia ETH, allowed tokens or testnet Bitcoin to the plan&apos;s vault addresses, shown on your plan page after saving.</span>
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>Anyone with a NEAR wallet can add NEAR to your plan for you.</span>
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>{sponsored ? "Behest covers the plan's storage and gas, so saving costs you nothing." : "Behest pays the gas for everything you sign."}</span>
          </li>
        </ul>
      </Card>
    );
  return (
    <Card className="flex flex-col gap-4">
      <Field label="NEAR to set aside" error={errors.deposit} hint="You can add or withdraw later, while no release is open. Zero is fine.">
        {(p) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center rounded-row bg-subtle px-4 focus-within:ring-2 focus-within:ring-signal/40">
              <input {...p} className="min-h-16 min-w-0 flex-1 bg-transparent text-[28px] font-bold outline-none" inputMode="decimal" value={d.deposit} onChange={(e) => set("deposit", e.target.value)} />
              <span className="text-xl font-medium text-muted">NEAR</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["0", "0.1", "0.5", "1"].map((x) => (
                <button key={x} type="button" onClick={() => set("deposit", x)} className={cx("min-h-9 rounded-full border px-3 text-sm", d.deposit === x ? "border-signal bg-s-approved" : "border-line hover:bg-subtle")}>
                  {x} NEAR
                </button>
              ))}
            </div>
          </div>
        )}
      </Field>
      <Notice tone={sponsored ? "ok" : "info"}>
        {sponsored ? "Behest covers the plan's storage, so saving needs no deposit." : "Saving also attaches 0.1 NEAR for the plan's storage; the contract refunds what it doesn't use."} {Number(d.deposit) > 0 ? "Adding NEAR is a second transaction." : ""}
      </Notice>
    </Card>
  );
}

/** "If you stop checking in": the release clock, with the plan's own durations. */
function Consequences({ plan }: { plan: PlanInput }) {
  const items: [string, string][] = [
    ["You stop checking in", `after ${duration(plan.check_in_interval_ms)}`],
    ["Grace period", plan.grace_ms > 0 ? duration(plan.grace_ms) : "none"],
    ["Guardians approve", plan.guardians.length ? `${plan.quorum || "?"} of ${plan.guardians.length}` : "—"],
    ["Waiting, you can cancel", duration(plan.waiting_period_ms)],
    ["Heirs receive", plan.heirs.length ? `${plan.heirs.length} heir${plan.heirs.length === 1 ? "" : "s"}` : "—"],
  ];
  return (
    <ol className="flex flex-col">
      {items.map(([k, v], i) => (
        <li key={k} className="relative flex items-start gap-3 pb-3 last:pb-0">
          {i < items.length - 1 && <span aria-hidden className="absolute bottom-0 left-[5px] top-4 w-0.5 bg-line" />}
          <span aria-hidden className={cx("relative mt-1.5 size-3 shrink-0 rounded-full", i === items.length - 1 ? "bg-signal" : "bg-card ring-2 ring-line-strong")} />
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-sm">
            <span>{k}</span>
            <span className="tabular shrink-0 text-muted">{v}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReviewStep({
  plan,
  d,
  owner,
  editing,
  depositYocto,
  onEdit,
  finalErrors,
  ack,
  setAck,
  evm,
  sponsored,
  spons,
}: {
  evm: boolean;
  sponsored: boolean;
  spons: Sponsorship | null | undefined;
  plan: PlanInput;
  d: Draft;
  owner: string;
  editing: boolean;
  depositYocto: bigint | null;
  onEdit: (s: WizardStep) => void;
  finalErrors: string[];
  ack: boolean;
  setAck: (b: boolean) => void;
}) {
  const edit = (s: WizardStep) => (
    <Button type="button" variant="ghost" size="sm" icon={Pencil} onClick={() => onEdit(s)}>
      Edit
    </Button>
  );
  return (
    <>
      <Card className="flex flex-col gap-4">
        <span className="text-sm font-semibold text-muted">What you&apos;re signing</span>
        <p className="text-[clamp(20px,2.4vw,26px)] leading-snug tracking-[-0.015em]">{describePlan(plan)}</p>
      </Card>
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={Timer} title="If you stop checking in" aside={edit("timing")} />
        <Consequences plan={plan} />
      </Card>
      <Card className="flex flex-col gap-3">
        <SectionTitle icon={ShieldCheck} title={`Guardians · any ${plan.quorum} of ${plan.guardians.length}`} aside={edit("guardians")} />
        <ul className="flex flex-wrap gap-2">
          {plan.guardians.map((g) => (
            <li key={g} className="inline-flex min-h-9 items-center rounded-full bg-subtle px-3 font-mono text-[13px]">
              {g}
            </li>
          ))}
        </ul>
      </Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-semibold text-muted">Heirs</span>
          {edit("heirs")}
        </div>
        <HeirList view={{ status: "Active", overdue_at_ms: 0, now_ms: 0, plan: { owner, version: 0, policy: plan, last_check_in_ms: 0, escrow: "0", eth_next_nonce: 0, proposal: null, proposals_opened: 0 } }} />
      </div>
      {!editing && depositYocto != null && depositYocto > 0n && (
        <Card className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-3">
            <Coins aria-hidden className="size-5 text-muted" />
            You&apos;ll put <strong>{d.deposit} NEAR</strong> into the plan (a second transaction).
          </span>
          {edit("funding")}
        </Card>
      )}
      <StorageNote evm={evm} sponsored={sponsored} spons={spons} />
      <Disclosure icon={ScrollText} title="Exact contract call" sub={evm ? "set_plan, inside the message your wallet signs" : "set_plan, as it will be signed"}>
        <pre className="overflow-auto rounded-tile bg-void p-4 font-mono text-xs leading-relaxed text-white">{JSON.stringify({ method: "set_plan", args: { plan } }, null, 2)}</pre>
      </Disclosure>
      {finalErrors.length > 0 && (
        <Notice tone="error" title="Fix these first">
          <ul className="list-disc pl-5">
            {finalErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-row border border-line bg-card p-4 text-[15px]">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
        <span>I understand that once a release is approved and its waiting period ends, it can&apos;t be cancelled, and that funds go only to the addresses above.</span>
      </label>
    </>
  );
}

/** Who pays for the plan's storage (D24), and what an Ethereum wallet can't do. */
function StorageNote({ evm, sponsored, spons }: { evm: boolean; sponsored: boolean; spons: Sponsorship | null | undefined }) {
  if (spons === undefined) return <Skeleton className="h-14 w-full rounded-row" />;
  if (sponsored)
    return (
      <Notice tone="ok" title="Behest covers the plan's storage">
        {evm ? "Your wallet signs a message; Behest sends it and pays the gas and storage. No ETH or NEAR leaves your wallet." : "No deposit needed. If Behest can't cover it this time, your wallet asks you to attach 0.1 NEAR instead (unused storage is refunded)."}
      </Notice>
    );
  if (evm)
    return (
      <Notice tone="warn" title="Behest can't cover storage right now">
        {spons === null ? "This deployment doesn't sponsor plan storage yet" : "Its sponsor pool or your allowance is used up"}, and an Ethereum wallet can&apos;t attach NEAR. Try again later, or sign in with a NEAR wallet.
      </Notice>
    );
  return <Notice>Saving attaches 0.1 NEAR for the plan&apos;s storage; the contract refunds what it doesn&apos;t use.</Notice>;
}

function SigningProgress({ phase, withDeposit, evm }: { phase: "idle" | "plan" | "deposit" | "done"; withDeposit: boolean; evm: boolean }) {
  const rows: [string, boolean, boolean][] = [
    ["Saving your plan", phase === "plan", phase === "deposit" || phase === "done"],
    ...(withDeposit ? [["Adding NEAR to the plan", phase === "deposit", phase === "done"] as [string, boolean, boolean]] : []),
  ];
  return (
    <ol role="status" className="flex flex-col gap-2 rounded-row border border-line bg-card p-4">
      {rows.map(([label, on, done]) => (
        <li key={label} className="flex items-center gap-3 text-[15px]">
          <span className={cx("flex size-6 items-center justify-center rounded-full", done ? "bg-ok-bg text-ok" : on ? "bg-s-approved text-[var(--s-approved-fg)]" : "bg-subtle text-muted")}>
            {done ? <Check aria-hidden className="size-3.5" /> : on ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : null}
          </span>
          <span className={cx(!on && !done && "text-muted")}>{label}</span>
          {on && <span className="text-sm text-muted">· {evm ? "sign the message in your wallet" : "confirm in your wallet"}</span>}
        </li>
      ))}
    </ol>
  );
}
