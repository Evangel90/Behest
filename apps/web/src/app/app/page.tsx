"use client";
// Home: what needs you, your own plan, and the plans you're part of.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, BellRing, ChevronRight, CirclePlus, FlaskConical, HeartPulse, Inbox, Search, UserRound } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { Countdown, useNow } from "@/components/interactive";
import { GetNotified } from "@/components/Notifications";
import { Stagger, StaggerItem } from "@/components/motion";
import { Avatar } from "@/components/PlanParts";
import { SignInDialog } from "@/components/SignIn";
import { useTx } from "@/components/tx";
import { Button, ButtonLink, Card, EmptyState, SectionTitle, Skeleton, StatusPill, cx } from "@/components/ui";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { watched } from "@/lib/demo";
import { ROLE_LABEL, nextStep } from "@/lib/guide";
import { actionsFor, formatNear, relative, rolesOf, shortName, type Role } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { PlanView } from "@/lib/types";

interface Entry {
  view: PlanView;
  roles: Role[];
}

export default function Home() {
  const { session, ready } = useSession();
  const [mine, setMine] = useState<PlanView | null | undefined>(undefined);
  const [others, setOthers] = useState<Entry[] | undefined>(undefined);
  const [signIn, setSignIn] = useState(false);
  const me = session?.accountId ?? null;

  const loadMine = useCallback(async () => {
    if (me) setMine(await getPlan(me).catch(() => null));
  }, [me]);

  useEffect(() => {
    if (!me) return;
    let off = false;
    void loadMine();
    (async () => {
      // Plans that may involve me: everything with an open release plus plans
      // this browser has opened (guardians and heirs arrive via the owner's link).
      const owners = [...new Set([...(await listOpenReleases().catch(() => [])), ...watched()])].filter((o) => o !== me);
      const views = await Promise.all(owners.map((o) => getPlan(o).catch(() => null)));
      const found = views.flatMap((v) => (v ? [{ view: v, roles: rolesOf(v, me) }] : [])).filter((e) => e.roles.length > 0);
      if (!off) setOthers(found);
    })();
    return () => {
      off = true;
    };
  }, [me, loadMine]);

  if (ready && !session) {
    return (
      <AppShell>
        <EmptyState icon={UserRound} title="Sign in to see your plans" body="Owners, guardians and heirs all start here. No wallet? Try every role with test personas.">
          <Button variant="primary" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
          <ButtonLink href="/try" variant="outline" icon={FlaskConical}>
            Try as a test persona
          </ButtonLink>
        </EmptyState>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </AppShell>
    );
  }

  const needsMe = (others ?? []).filter((e) => e.roles.some((r) => actionsFor(e.view, r, me ?? undefined).can.length > 0));
  const name = session ? (session.kind === "persona" ? session.label.split(" ")[0] : shortName(session.accountId)) : "";
  return (
    <AppShell>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted">Home</span>
        <h1 className="text-[clamp(40px,6vw,64px)] font-medium leading-[0.92] tracking-[-0.045em]">{session ? `Hello, ${name}.` : <Skeleton className="h-14 w-64" />}</h1>
      </div>

      {needsMe.length > 0 && (
        <section aria-labelledby="needs-you" className="flex flex-col gap-3 rounded-card bg-void p-5 text-white sm:p-6">
          <h2 id="needs-you" className="flex items-center gap-2 text-sm font-semibold text-muted-dark">
            <BellRing aria-hidden className="size-4 text-signal-text" />
            Needs you · {needsMe.length}
          </h2>
          <Stagger className="flex flex-col gap-2">
            {needsMe.map((e) => (
              <StaggerItem key={e.view.plan.owner}>
                <PlanRow entry={e} me={me} dark />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}

      <section aria-labelledby="your-plan" className="flex flex-col gap-3">
        <h2 id="your-plan" className="px-1 text-sm font-semibold text-muted">
          Your plan
        </h2>
        {mine === undefined && <MyPlanSkeleton />}
        {mine === null && (
          <EmptyState icon={CirclePlus} title="You don't have a plan yet" body="Start from a preset, choose guardians and heirs (publicly or privately), and put something aside. It takes a few minutes.">
            <ButtonLink href="/setup" variant="primary" iconRight={ArrowRight}>
              Create a plan
            </ButtonLink>
          </EmptyState>
        )}
        {mine && <MyPlan view={mine} onChange={loadMine} />}
        {mine && <GetNotified role="owner" />}
      </section>

      <section aria-labelledby="part-of" className="flex flex-col gap-3">
        <h2 id="part-of" className="px-1 text-sm font-semibold text-muted">
          Plans you&apos;re part of
        </h2>
        {others === undefined ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[76px] w-full rounded-row" />
            <Skeleton className="h-[76px] w-full rounded-row" />
          </div>
        ) : others.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing here yet" body="When someone names you as a guardian or heir, open the link they send you. Their plan shows up here after that. A private heir appears once they've revealed their recovery record.">
            <ButtonLink href="/inspect" variant="outline" icon={Search}>
              Look up a plan
            </ButtonLink>
          </EmptyState>
        ) : (
          <Stagger className="flex flex-col gap-2">
            {others.map((e) => (
              <StaggerItem key={e.view.plan.owner}>
                <PlanRow entry={e} me={me} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>
    </AppShell>
  );
}

function MyPlanSkeleton() {
  return (
    <Card className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-7 w-24 rounded-tag" />
      <Skeleton className="h-9 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-12 w-40 rounded-tile" />
    </Card>
  );
}

/** The owner's own plan: where it stands, and the one thing to do about it. */
function MyPlan({ view, onChange }: { view: PlanView; onChange: () => Promise<void> }) {
  const { busy, act } = useTx(onChange);
  const live = useNow();
  // Shift the local clock onto chain time so countdowns match the plan page.
  const now = live + (view.now_ms - live > 60_000 || live - view.now_ms > 60_000 ? view.now_ms - live : 0);
  const p = view.plan;
  const s = view.status;
  const open = s === "Proposed" || s === "Waiting";
  const canCheckIn = s === "Active" || s === "Overdue" || open;
  const step = nextStep(view, "owner", { now, me: p.owner });
  const facts = [`${p.policy.heirs.length} heir${p.policy.heirs.length === 1 ? "" : "s"}`, `${p.policy.quorum} of ${p.policy.guardians.length} guardians`, `${formatNear(p.escrow)} NEAR held`, `version ${p.version}`];
  return (
    <Card className={cx("flex flex-col gap-4", step.tone === "urgent" && "ring-2 ring-warn/50")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill status={s} />
        <span className="text-sm text-muted">last check-in {relative(p.last_check_in_ms, now)}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[clamp(22px,3vw,28px)] font-medium leading-tight tracking-[-0.02em]">{step.title}</p>
        {s === "Active" && <Countdown to={view.overdue_at_ms} now={now} prefix="Next check-in due in " className="text-[15px] text-muted" />}
        {s !== "Active" && <p className="text-[15px] leading-relaxed text-muted">{step.body}</p>}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {facts.map((f) => (
          <li key={f} className="rounded-full bg-subtle px-3 py-1 text-[13px] text-muted">
            {f}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {canCheckIn && (
          <Button
            variant={s === "Active" ? "outline" : "primary"}
            icon={HeartPulse}
            loading={!!busy}
            onClick={() => act(open ? "Check in (cancels the release)" : "Check in", "check_in", {}, { done: open ? "You're here. The release is cancelled." : "Checked in. The clock has restarted." })}
          >
            {open ? "I'm here, check in and cancel" : "Check in now"}
          </Button>
        )}
        <ButtonLink href={`/plan/${encodeURIComponent(p.owner)}`} variant={canCheckIn && s !== "Active" ? "outline" : "ink"} iconRight={ArrowRight}>
          Open plan
        </ButtonLink>
      </div>
    </Card>
  );
}

function PlanRow({ entry, me, dark }: { entry: Entry; me: string | null; dark?: boolean }) {
  const { view, roles } = entry;
  const role = roles.find((r) => actionsFor(view, r, me ?? undefined).can.length > 0) ?? roles[0]!;
  const step = nextStep(view, role, { now: view.now_ms, me });
  return (
    <Link
      href={`/plan/${encodeURIComponent(view.plan.owner)}?as=${role}`}
      className={cx(
        "group flex min-h-[76px] items-center gap-3 rounded-row border p-3 pr-4 transition-colors sm:p-4",
        dark ? "border-line-dark bg-white/[0.03] hover:border-signal" : "border-line bg-card hover:border-line-strong hover:bg-subtle/60",
      )}
    >
      <Avatar name={view.plan.owner} i={0} size={44} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[17px] font-semibold">{shortName(view.plan.owner)}&apos;s plan</span>
        <span className={cx("truncate text-sm", dark ? "text-muted-dark" : "text-muted")}>{dark ? step.title : `You're ${roles.map((r) => (r === "heir" ? "an heir" : `a ${ROLE_LABEL[r].toLowerCase()}`)).join(" and ")}`}</span>
      </span>
      <span className="hidden sm:block">
        <StatusPill status={view.status} />
      </span>
      <ChevronRight aria-hidden className={cx("size-5 shrink-0 transition-transform group-hover:translate-x-0.5", dark ? "text-muted-dark" : "text-muted")} />
    </Link>
  );
}
