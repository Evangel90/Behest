"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader, TestnetBar } from "@/components/chrome";
import { SignInDialog } from "@/components/SignIn";
import { Bracket, Button, ButtonLink, Card, StatusPill } from "@/components/ui";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { watched } from "@/lib/demo";
import { actionsFor, describePlan, rolesOf, shortName, type Role } from "@/lib/plan";
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
          <h1 className="font-display text-4xl font-bold tracking-[-0.03em]">Sign in to see your plans</h1>
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
        <h1 className="font-display text-[clamp(40px,6vw,64px)] font-bold leading-[0.92] tracking-[-0.045em]">
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
        {mine && (
          <Link href={`/plan/${mine.plan.owner}`} className="flex flex-col gap-2 rounded-tile border border-line p-4 hover:border-ink">
            <StatusPill status={mine.status} />
            <span className="text-base leading-relaxed">{describePlan(mine.plan.policy)}</span>
          </Link>
        )}
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

function PlanRow({ entry, dark }: { entry: Entry; dark?: boolean }) {
  const { view, roles } = entry;
  return (
    <Link
      href={`/plan/${view.plan.owner}`}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-tile border p-4 ${dark ? "border-line-dark hover:border-mint" : "border-line hover:border-ink"}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="font-display text-xl font-bold">{shortName(view.plan.owner)}'s plan</span>
        <span className={`text-sm ${dark ? "text-muted-dark" : "text-muted"}`}>You're {roles.map((r) => (r === "heir" ? "an heir" : `a ${r}`)).join(" and ")}</span>
      </span>
      <StatusPill status={view.status} />
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TestnetBar />
      <AppHeader />
      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
