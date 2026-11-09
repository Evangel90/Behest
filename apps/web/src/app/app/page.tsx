"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/chrome";
import { SignInDialog } from "@/components/SignIn";
import { Bracket, Button, ButtonLink, Card, Notice, StatusPill } from "@/components/ui";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { watched } from "@/lib/demo";
import { useAction } from "@/lib/hooks";
import { actionsFor, formatNear, relative, rolesOf, shortName, when, type Role } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { PlanView } from "@/lib/types";

interface Entry {
  view: PlanView;
  roles: Role[];
}

export default function Home() {
  const { session, ready } = useSession();
  const [mine, setMine] = useState<PlanView | null | undefined>(undefined);
  const [others, setOthers] = useState<Entry[]>([]);
  const [signIn, setSignIn] = useState(false);

  useEffect(() => {
    if (!session) return;
    const me = session.accountId;
    let off = false;
    (async () => {
      setMine(await getPlan(me).catch(() => null));
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
  }, [session]);

  if (ready && !session) {
    return (
      <Shell>
        <Card className="flex flex-col gap-4">
          <h1 className="text-4xl font-medium tracking-[-0.03em]">Sign in to see your plans</h1>
          <p className="text-muted">Owners, guardians and heirs all start here. No wallet? Try every role with test personas.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setSignIn(true)}>Sign in</Button>
            <ButtonLink href="/try" variant="outline">
              Try as a test persona
            </ButtonLink>
          </div>
        </Card>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </Shell>
    );
  }

  const needsMe = others.filter((e) => e.roles.some((r) => actionsFor(e.view, r, session?.accountId).can.length > 0));
  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <Bracket>Home</Bracket>
        <h1 className="text-[clamp(40px,6vw,64px)] font-medium leading-[0.92] tracking-[-0.045em]">
          Hello{session ? `, ${session.kind === "persona" ? session.label.split(" ")[0] : shortName(session.accountId)}` : ""}.
        </h1>
      </div>

      {needsMe.length > 0 && (
        <Card dark className="flex flex-col gap-3">
          <Bracket dark>Needs you</Bracket>
          {needsMe.map((e) => (
            <PlanRow key={e.view.plan.owner} entry={e} dark />
          ))}
        </Card>
      )}

      <Card className="flex flex-col gap-3">
        <Bracket>Your plan</Bracket>
        {mine === undefined && <p className="text-muted">Loading…</p>}
        {mine === null && (
          <div className="flex flex-col gap-3">
            <p>You don't have a plan yet.</p>
            <ButtonLink href="/setup" className="self-start">
              Create a plan
            </ButtonLink>
          </div>
        )}
        {mine && session && <MyPlan view={mine} onChange={() => getPlan(session.accountId).then(setMine).catch(() => {})} />}
      </Card>

      {others.length > 0 && (
        <Card className="flex flex-col gap-3">
          <Bracket>Plans you're part of</Bracket>
          {others.map((e) => (
            <PlanRow key={e.view.plan.owner} entry={e} />
          ))}
        </Card>
      )}
    </Shell>
  );
}

/** The owner's own plan: where it stands, and the one thing to do about it. */
function MyPlan({ view, onChange }: { view: PlanView; onChange: () => void }) {
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const p = view.plan;
  const now = view.now_ms;
  const open = !!p.proposal && view.status !== "Settled";
  const canCheckIn = view.status === "Active" || view.status === "Overdue" || open;
  const due = view.status === "Active" ? `Next check-in due ${relative(view.overdue_at_ms, now)}` : view.status === "Overdue" ? `Check-in overdue since ${when(view.overdue_at_ms)}` : null;
  const facts = [
    `${p.policy.heirs.length} heir${p.policy.heirs.length === 1 ? "" : "s"}`,
    `${p.policy.quorum} of ${p.policy.guardians.length} guardians`,
    `${formatNear(p.escrow)} NEAR held`,
    `version ${p.version}`,
  ];
  return (
    <div className="flex flex-col gap-4 rounded-tile border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill status={view.status} />
        <span className="text-sm text-muted">last check-in {relative(p.last_check_in_ms, now)}</span>
      </div>
      {due && <p className="text-2xl font-medium tracking-[-0.02em]">{due}.</p>}
      {open && <p className="text-2xl font-medium tracking-[-0.02em]">A release is under way. Checking in cancels it while the waiting period runs.</p>}
      <p className="text-sm text-muted">{facts.join(" · ")}</p>
      <div className="flex flex-wrap gap-2">
        {canCheckIn && (
          <Button
            variant={view.status === "Active" ? "outline" : "primary"}
            disabled={!!busy}
            onClick={() => void run("Check in", async () => session!.call("check_in", {}), "Checked in.").then(onChange)}
          >
            {busy ? "Checking in…" : open ? "I'm here: check in and cancel" : "Check in now"}
          </Button>
        )}
        <ButtonLink href={`/plan/${p.owner}`} variant={canCheckIn && view.status !== "Active" ? "outline" : "ink"}>
          Open plan
        </ButtonLink>
      </div>
      {result && <Notice tone={result.ok ? "ok" : "error"}>{result.text}</Notice>}
    </div>
  );
}

function PlanRow({ entry, dark }: { entry: Entry; dark?: boolean }) {
  const { view, roles } = entry;
  return (
    <Link
      href={`/plan/${view.plan.owner}`}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-tile border p-4 ${dark ? "border-line-dark hover:border-signal" : "border-line hover:border-line-strong"}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-xl font-medium">{shortName(view.plan.owner)}'s plan</span>
        <span className={`text-sm ${dark ? "text-muted-dark" : "text-muted"}`}>You're {roles.map((r) => (r === "heir" ? "an heir" : `a ${r}`)).join(" and ")}</span>
      </span>
      <StatusPill status={view.status} />
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>{children}</AppShell>
  );
}
