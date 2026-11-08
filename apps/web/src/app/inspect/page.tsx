"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader, TestnetBar } from "@/components/chrome";
import { InspectForm } from "@/components/InspectForm";
import { Bracket, Card, StatusPill } from "@/components/ui";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { shortName } from "@/lib/plan";
import type { PlanView } from "@/lib/types";

export default function Inspect() {
  const [open, setOpen] = useState<PlanView[] | null>(null);
  useEffect(() => {
    (async () => {
      const owners = await listOpenReleases().catch(() => []);
      const views = await Promise.all(owners.map((o) => getPlan(o).catch(() => null)));
      setOpen(views.filter((v): v is PlanView => !!v));
    })();
  }, []);
  return (
    <div className="min-h-dvh">
      <TestnetBar />
      <AppHeader />
      <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-3">
          <Bracket>Public inspector</Bracket>
          <h1 className="font-display text-[clamp(40px,6vw,72px)] font-bold leading-[0.92] tracking-[-0.045em]">Every rule is public.</h1>
          <p className="max-w-[680px] text-lg leading-relaxed">Look up any plan by its owner's account to see its rules, guardians, heirs, open release and every transfer, read straight from the chain.</p>
        </div>
        <InspectForm />
        <Card className="flex flex-col gap-3">
          <Bracket>Open releases right now</Bracket>
          {open === null && <p className="text-muted">Loading…</p>}
          {open?.length === 0 && <p className="text-muted">No releases are open.</p>}
          {open?.map((v) => (
            <Link key={v.plan.owner} href={`/plan/${v.plan.owner}?view=inspect`} className="flex flex-wrap items-center justify-between gap-3 rounded-tile border border-line p-3 hover:border-ink">
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{shortName(v.plan.owner)}</span>
                <span className="truncate font-mono text-xs text-muted">{v.plan.owner}</span>
              </span>
              <StatusPill status={v.status} />
            </Link>
          ))}
        </Card>
      </main>
    </div>
  );
}
