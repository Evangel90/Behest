"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/chrome";
import { SignInDialog } from "@/components/SignIn";
import { HeirList } from "@/components/PlanParts";
import { Bracket, Button, Card, Field, Notice, inputClass } from "@/components/ui";
import { getConfig, getPlan } from "@/lib/contract";
import { humanError } from "@/lib/hooks";
import { describePlan, duration, parseNear, percent, validateDraft } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { PlanInput, PlanView } from "@/lib/types";

type Unit = "minutes" | "days";
const MS: Record<Unit, number> = { minutes: 60_000, days: 86_400_000 };
interface Timer {
  n: string;
  unit: Unit;
}
interface HeirDraft {
  account: string;
  pct: string;
  near: string;
  eth: string;
}

const toMs = (t: Timer) => Math.round(Number(t.n) * MS[t.unit]);
const fromMs = (ms: number): Timer => (ms % MS.days === 0 && ms > 0 ? { n: String(ms / MS.days), unit: "days" } : { n: String(ms / MS.minutes), unit: "minutes" });

export default function SetupPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const router = useRouter();
  const editing = useSearchParams().get("edit") === "1";
  const { session, ready } = useSession();
  const [demo, setDemo] = useState(true);
  const [existing, setExisting] = useState<PlanView | null>(null);
  const [checkIn, setCheckIn] = useState<Timer>({ n: "5", unit: "minutes" });
  const [grace, setGrace] = useState<Timer>({ n: "0", unit: "minutes" });
  const [waiting, setWaiting] = useState<Timer>({ n: "5", unit: "minutes" });
  const [guardians, setGuardians] = useState<string[]>(["", ""]);
  const [quorum, setQuorum] = useState("2");
  const [heirs, setHeirs] = useState<HeirDraft[]>([{ account: "", pct: "100", near: "", eth: "" }]);
  const [deposit, setDeposit] = useState("0.5");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);

  useEffect(() => void getConfig().then((c) => setDemo(c.demo_timers)).catch(() => {}), []);
  useEffect(() => {
    if (!session) return;
    getPlan(session.accountId)
      .then((v) => {
        setExisting(v);
        if (v && editing) {
          const p = v.plan.policy;
          setCheckIn(fromMs(p.check_in_interval_ms));
          setGrace(fromMs(p.grace_ms));
          setWaiting(fromMs(p.waiting_period_ms));
          setGuardians(p.guardians);
          setQuorum(String(p.quorum));
          setHeirs(p.heirs.map((h) => ({ account: h.account_id, pct: String(h.share_bps / 100), near: h.near_destination ?? "", eth: h.eth_destination ?? "" })));
          setDeposit("0");
        }
      })
      .catch(() => {});
  }, [session, editing]);

  const plan: PlanInput = useMemo(
    () => ({
      check_in_interval_ms: toMs(checkIn),
      grace_ms: toMs(grace),
      waiting_period_ms: toMs(waiting),
      guardians: guardians.map((g) => g.trim().toLowerCase()).filter(Boolean),
      quorum: Number(quorum) || 0,
      heirs: heirs.map((h) => ({
        account_id: h.account.trim().toLowerCase(),
        share_bps: Math.round(Number(h.pct) * 100) || 0,
        near_destination: (h.near.trim() || h.account.trim()).toLowerCase() || null,
        eth_destination: h.eth.trim() ? h.eth.trim().toLowerCase() : null,
      })),
    }),
    [checkIn, grace, waiting, guardians, quorum, heirs],
  );
  const errors = session ? validateDraft(plan, session.accountId) : [];
  const timerErrors = [
    !demo && plan.check_in_interval_ms < 30 * MS.days && "Check-in must be at least 30 days.",
    !demo && (plan.grace_ms < MS.days || plan.grace_ms > 30 * MS.days) && "Grace must be between 1 and 30 days.",
    !demo && plan.waiting_period_ms < 7 * MS.days && "Waiting period must be at least 7 days.",
    demo && plan.check_in_interval_ms < MS.minutes && "Check-in must be at least 1 minute.",
    demo && plan.waiting_period_ms < MS.minutes && "Waiting period must be at least 1 minute.",
  ].filter((e): e is string => !!e);
  const allErrors = [...timerErrors, ...errors];

  let depositYocto: bigint | null = null;
  try {
    depositYocto = parseNear(deposit || "0");
  } catch {}

  async function submit() {
    if (!session) return;
    setError(null);
    try {
      setBusy("Saving your plan…");
      // Storage deposit; the contract refunds whatever it doesn't use.
      await session.call("set_plan", { plan }, { deposit: 100_000_000_000_000_000_000_000n });
      if (depositYocto && depositYocto > 0n) {
        setBusy("Adding NEAR to the plan…");
        await session.call("deposit", { owner: session.accountId }, { deposit: depositYocto });
      }
      router.push(`/plan/${session.accountId}`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }

  if (ready && !session) {
    return (
      <Shell>
        <Card className="flex flex-col gap-3">
          <h1 className="text-4xl font-medium tracking-[-0.03em]">Sign in to create a plan</h1>
          <p className="text-muted">The account you sign in with becomes the plan owner.</p>
          <Button className="self-start" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
        </Card>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </Shell>
    );
  }

  const unitSelect = (t: Timer, set: (t: Timer) => void, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input className={`${inputClass} w-28`} inputMode="decimal" value={t.n} onChange={(e) => set({ ...t, n: e.target.value })} aria-label={`${label} amount`} />
        <select className={`${inputClass} w-36`} value={t.unit} onChange={(e) => set({ ...t, unit: e.target.value as Unit })} aria-label={`${label} unit`}>
          {demo && <option value="minutes">minutes</option>}
          <option value="days">days</option>
        </select>
      </div>
    </Field>
  );

  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <Bracket>{editing ? "Edit plan" : "Create a plan"}</Bracket>
        <h1 className="text-[clamp(40px,6vw,64px)] font-medium leading-[0.92] tracking-[-0.045em]">{step === "edit" ? "Set your rules." : "Read it once more."}</h1>
        {existing && !editing && <Notice>You already have a plan. Saving replaces it and counts as a check-in.</Notice>}
        {demo && <p className="text-sm text-muted">This is a demo-timer deployment: minutes are allowed so you can watch a release end to end.</p>}
      </div>

      {step === "edit" && (
        <>
          <Card className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {unitSelect(checkIn, setCheckIn, "Check in every", "Miss this and you count as unreachable.")}
            {unitSelect(grace, setGrace, "Then allow grace of", "Extra time before guardians can act.")}
            {unitSelect(waiting, setWaiting, "Waiting period", "After approval; you can still cancel.")}
          </Card>

          <Card className="flex flex-col gap-4">
            <Bracket>Guardians</Bracket>
            <p className="text-sm text-muted">People you trust to notice you're unreachable. They can only release the plan exactly as written.</p>
            {guardians.map((g, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder="guardian.testnet"
                  value={g}
                  onChange={(e) => setGuardians(guardians.map((x, j) => (j === i ? e.target.value : x)))}
                  aria-label={`Guardian ${i + 1} account`}
                  spellCheck={false}
                />
                {guardians.length > 1 && (
                  <Button variant="outline" onClick={() => setGuardians(guardians.filter((_, j) => j !== i))} aria-label={`Remove guardian ${i + 1}`}>
                    ✕
                  </Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <Button variant="outline" onClick={() => setGuardians([...guardians, ""])}>
                Add guardian
              </Button>
              <Field label="Approvals needed">
                <input className={`${inputClass} w-24`} inputMode="numeric" value={quorum} onChange={(e) => setQuorum(e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card className="flex flex-col gap-4">
            <Bracket>Heirs · fixed destinations</Bracket>
            {heirs.map((h, i) => (
              <div key={i} className="grid gap-3 rounded-tile border border-line p-3 md:grid-cols-[1.2fr_0.5fr_1.2fr_1.6fr_auto]">
                <Field label="Heir account">
                  <input className={inputClass} placeholder="amara.testnet" value={h.account} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} spellCheck={false} />
                </Field>
                <Field label="Share %">
                  <input className={inputClass} inputMode="decimal" value={h.pct} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
                </Field>
                <Field label="NEAR goes to" hint="Defaults to the heir account">
                  <input className={inputClass} placeholder={h.account || "amara.testnet"} value={h.near} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, near: e.target.value } : x)))} spellCheck={false} />
                </Field>
                <Field label="ETH goes to (optional)">
                  <input className={inputClass} placeholder="0x…" value={h.eth} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, eth: e.target.value } : x)))} spellCheck={false} />
                </Field>
                {heirs.length > 1 && (
                  <Button variant="outline" className="self-end" onClick={() => setHeirs(heirs.filter((_, j) => j !== i))} aria-label={`Remove heir ${i + 1}`}>
                    ✕
                  </Button>
                )}
              </div>
            ))}
            <Button variant="outline" className="self-start" onClick={() => setHeirs([...heirs, { account: "", pct: "0", near: "", eth: "" }])}>
              Add heir
            </Button>
          </Card>

          {!editing && (
            <Card className="flex flex-col gap-3">
              <Bracket>NEAR to set aside</Bracket>
              <Field label="Amount (NEAR)" hint="You can add or withdraw later, while no release is open." error={depositYocto === null ? "Not a valid amount." : undefined}>
                <input className={`${inputClass} w-40`} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </Field>
            </Card>
          )}

          {allErrors.length > 0 && (
            <Notice tone="error">
              <ul className="list-disc pl-5">
                {allErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Notice>
          )}
          <Button className="self-start" disabled={allErrors.length > 0 || depositYocto === null} onClick={() => setStep("review")}>
            Review in plain words
          </Button>
        </>
      )}

      {step === "review" && session && (
        <>
          <Card className="flex flex-col gap-4">
            <Bracket>What you're signing</Bracket>
            <p className="text-2xl leading-snug tracking-[-0.01em]">{describePlan(plan)}</p>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <span>Check in every {duration(plan.check_in_interval_ms)}</span>
              <span>Grace {duration(plan.grace_ms)}</span>
              <span>Waiting period {duration(plan.waiting_period_ms)}</span>
            </div>
            <p className="text-sm">
              Guardians ({plan.quorum} of {plan.guardians.length} must approve): {plan.guardians.join(", ")}
            </p>
            {!editing && depositYocto && depositYocto > 0n && <p className="text-sm">You'll also put {deposit} NEAR into the plan (a second transaction).</p>}
          </Card>
          <HeirList view={{ status: "Active", overdue_at_ms: 0, now_ms: 0, plan: { owner: session.accountId, version: 0, policy: plan, last_check_in_ms: 0, escrow: "0", eth_next_nonce: 0, proposal: null, proposals_opened: 0 } }} />
          <details className="rounded-card border border-line p-4">
            <summary className="min-h-11 cursor-pointer content-center font-semibold">Exact contract call</summary>
            <pre className="mt-2 overflow-auto rounded-tile bg-void p-4 font-mono text-xs text-white">{JSON.stringify({ method: "set_plan", args: { plan } }, null, 2)}</pre>
            <p className="pt-2 text-xs text-muted">Shares: {plan.heirs.map((h) => `${h.account_id} ${percent(h.share_bps)}`).join(" · ")}</p>
          </details>
          {error && <Notice tone="error">{error}</Notice>}
          {busy && <Notice>{busy}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setStep("edit")} disabled={!!busy}>
              Back
            </Button>
            <Button variant="mint" onClick={submit} disabled={!!busy}>
              {busy ? "Signing…" : "Sign and save"}
            </Button>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>{children}</AppShell>
  );
}
