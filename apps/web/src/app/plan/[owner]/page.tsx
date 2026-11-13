"use client";
// One plan, seen through the signed-in person's role: owner, guardian, heir,
// delay signer, or the public inspector. Each view leads with what that
// person needs to do now.
import { useSealed } from "@/components/Sealed";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { CirclePlus, FileQuestion, Mail, RotateCcw, Search, WifiOff } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { PlanHeader, type PlanCtx } from "@/components/plan/common";
import { DelayView, GuardianView } from "@/components/plan/GuardianView";
import { HeirView } from "@/components/plan/HeirView";
import { OwnerView } from "@/components/plan/OwnerView";
import { DaoBanner, DaoProposals, DelegateCheckIn } from "@/components/Dao";
import { PublicView } from "@/components/plan/PublicView";
import { PendingChanges, StandbyCard, useRecovery } from "@/components/Recovery";
import { useDestinations } from "@/components/Destinations";
import { useOptions } from "@/components/ReleaseOptions";
import { useRules } from "@/components/ReleaseRules";
import { lastSettledAt, useHistory } from "@/components/Rounds";
import { Swap } from "@/components/motion";
import { Button, ButtonLink, Card, EmptyState, Skeleton } from "@/components/ui";
import { watch } from "@/lib/demo";
import type { UiRole } from "@/lib/guide";
import { usePlan } from "@/lib/hooks";
import { namedPlans, usePeopleNames } from "@/lib/people";
import { followUpOpen, rolesOf, shortName } from "@/lib/plan";
import { SignInDialog } from "@/components/SignIn";
import { useSession } from "@/lib/session";

const EMAIL_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

export default function PlanPage() {
  return (
    <Suspense>
      <PlanScreen />
    </Suspense>
  );
}

function PlanScreen() {
  const owner = decodeURIComponent(useParams<{ owner: string }>().owner);
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { session, ready } = useSession();
  const me = session?.accountId ?? null;
  const [signIn, setSignIn] = useState(false);
  // Names instead of the accounts made for emails: the owner's people, and (for someone signed in by email) the owner.
  usePeopleNames(me);
  const [, setNamed] = useState(0);
  useEffect(() => {
    if (session?.email) void namedPlans(session).then(() => setNamed((n) => n + 1), () => {});
  }, [session]);
  const { view, error, refresh, chainNow } = usePlan(owner);
  const prop = view?.plan.proposal;
  const options = useOptions(owner, prop?.id, prop?.waiting_ends_at_ms);
  const rules = useRules(owner);
  const history = useHistory(owner, view ? `${view.status}:${prop?.id}` : undefined);
  const recovery = useRecovery(owner, view ? `${view.plan.version}:${view.status}:${view.plan.policy.guardians.join()}:${prop?.approvals.join()}` : undefined);
  const sealed = useSealed(owner, view ? `${view.plan.version}:${view.status}:${view.plan.last_check_in_ms}:${view.now_ms >= view.overdue_at_ms}` : undefined);
  const destinations = useDestinations(owner, view ? `${view.plan.version}:${view.status}:${recovery.pending.length}` : undefined);

  const roles = useMemo<UiRole[]>(() => {
    const r: UiRole[] = rolesOf(view ?? null, me);
    if (me && options.options?.delay_signers.includes(me)) r.push("delay");
    return [...r, "public"];
  }, [view, me, options.options]);

  const asked = search.get("as") as UiRole | null;
  const forced = search.get("view") === "inspect" ? "public" : null;
  const role: UiRole = (asked && roles.includes(asked) ? asked : null) ?? forced ?? roles[0]!;
  const setRole = (r: UiRole) => {
    const q = new URLSearchParams(search.toString());
    q.delete("view");
    q.set("as", r);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (view) watch(owner);
  }, [view, owner]);

  const ctx: PlanCtx | null = view
    ? { view, now: chainNow, me, refresh, rules, history, followUp: followUpOpen(view, lastSettledAt(history)), options, recovery, destinations, sealed }
    : null;

  return (
    <AppShell>
      {view === undefined && !error && <PlanSkeleton />}
      {error && view === undefined && (
        <EmptyState icon={WifiOff} tone="error" title="Couldn't load this plan" body={`The NEAR network didn't answer: ${error}. Your plan is safe; this is only a display problem.`}>
          <Button variant="ink" icon={RotateCcw} onClick={() => void refresh()}>
            Try again
          </Button>
        </EmptyState>
      )}
      {view !== undefined && <DaoBanner />}
      {view !== undefined && <DaoProposals owner={owner} onChange={refresh} />}
      {view === null && (
        <EmptyState icon={FileQuestion} title={`No plan for ${owner}`} body="Check the account name. If it's yours, you can create a plan in a few minutes.">
          <ButtonLink href="/inspect" variant="outline" icon={Search}>
            Search again
          </ButtonLink>
          {me === owner && (
            <ButtonLink href="/setup" variant="primary" icon={CirclePlus}>
              Create a plan
            </ButtonLink>
          )}
        </EmptyState>
      )}
      {ctx && ready && (
        <>
          <PlanHeader view={ctx.view} role={role} roles={roles} onRole={setRole} />
          {!session && EMAIL_ENABLED && (
            <section aria-label="Were you named in this plan?" className="flex animate-fade-up flex-wrap items-center gap-4 rounded-card border border-signal/40 bg-s-approved/40 p-5">
              <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-tile bg-card text-signal-text">
                <Mail className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                <span className="text-[17px] font-semibold">Did an email bring you here?</span>
                <span className="text-[15px] text-muted">Sign in with the address it was sent to. You don&apos;t need a wallet: {shortName(owner)} already set aside an account for you.</span>
              </span>
              <Button variant="primary" onClick={() => setSignIn(true)}>
                Sign in with email
              </Button>
              <SignInDialog open={signIn} onClose={() => setSignIn(false)} email />
            </section>
          )}
          {error && <p className="text-sm text-muted">Showing the last update; reconnecting…</p>}
          <PendingChanges owner={owner} me={me} rec={recovery} now={chainNow} onChanged={refresh} />
          <DelegateCheckIn owner={owner} me={me ?? ""} open={!!ctx.view.plan.proposal && ctx.view.status !== "Settled"} onDone={refresh} />
          <StandbyCard owner={owner} me={me} rec={recovery} now={chainNow} />
          <Swap id={role} className="flex flex-col gap-6">
            {role === "owner" && <OwnerView ctx={ctx} />}
            {role === "guardian" && <GuardianView ctx={ctx} />}
            {role === "heir" && <HeirView ctx={ctx} />}
            {role === "delay" && <DelayView ctx={ctx} />}
            {role === "public" && <PublicView ctx={ctx} />}
          </Swap>
        </>
      )}
      {ctx && !ready && <PlanSkeleton />}
    </AppShell>
  );
}

function PlanSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading plan" className="flex flex-col gap-6">
      <div className="flex items-center gap-3.5">
        <Skeleton className="size-[52px] rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <Card className="flex flex-col gap-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-4 w-full max-w-[520px]" />
        <Skeleton className="h-12 w-48 rounded-tile" />
      </Card>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col gap-3">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-4 w-40" />
          </Card>
        ))}
      </div>
      <span className="sr-only">Loading the plan from the NEAR network…</span>
    </div>
  );
}

