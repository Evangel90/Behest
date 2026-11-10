"use client";
// Public inspector: look up any plan, or browse releases open right now.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Eye, Inbox, RotateCcw, WifiOff } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { InspectForm } from "@/components/InspectForm";
import { Stagger, StaggerItem } from "@/components/motion";
import { Avatar } from "@/components/PlanParts";
import { Button, EmptyState, Skeleton, StatusPill } from "@/components/ui";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { relative, shortName } from "@/lib/plan";
import type { PlanView } from "@/lib/types";

export default function Inspect() {
  const [open, setOpen] = useState<PlanView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    setOpen(null);
    try {
      const owners = await listOpenReleases();
      const views = await Promise.all(owners.map((o) => getPlan(o).catch(() => null)));
      setOpen(views.filter((v): v is PlanView => !!v));
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <AppShell>
      <div className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <Eye aria-hidden className="size-4" />
          Public inspector
        </span>
        <h1 className="text-[clamp(40px,6vw,72px)] font-medium leading-[0.92] tracking-[-0.045em]">Every rule is public.</h1>
        <p className="max-w-[680px] text-lg leading-relaxed text-muted">Look up any plan by its owner&apos;s account to see its rules, guardians, heirs, open release and every transfer, read straight from the chain.</p>
      </div>
      <InspectForm recent />
      <section aria-labelledby="open-now" className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <h2 id="open-now" className="text-sm font-semibold text-muted">
            Open releases right now{open ? ` · ${open.length}` : ""}
          </h2>
          <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => void load()} aria-label="Refresh open releases">
            Refresh
          </Button>
        </div>
        {failed ? (
          <EmptyState icon={WifiOff} tone="error" title="Couldn't reach the NEAR network" body="Nothing is wrong with any plan; this page just couldn't load the list.">
            <Button variant="ink" icon={RotateCcw} onClick={() => void load()}>
              Try again
            </Button>
          </EmptyState>
        ) : open === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[72px] w-full rounded-row" />
            ))}
          </div>
        ) : open.length === 0 ? (
          <EmptyState icon={Inbox} title="No releases are open" body="Every plan on this contract is quiet right now. You can still look one up above." />
        ) : (
          <Stagger className="flex flex-col gap-2">
            {open.map((v) => (
              <StaggerItem key={v.plan.owner}>
                <Link href={`/plan/${encodeURIComponent(v.plan.owner)}?view=inspect`} className="group flex min-h-[72px] items-center gap-3 rounded-row border border-line bg-card p-3 pr-4 transition-colors hover:border-line-strong hover:bg-subtle/60">
                  <Avatar name={v.plan.owner} i={0} size={40} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">{shortName(v.plan.owner)}</span>
                    <span className="truncate font-mono text-xs text-muted">{v.plan.owner}</span>
                  </span>
                  <span className="hidden text-xs text-muted md:block">{v.plan.proposal ? `opened ${relative(v.plan.proposal.created_at_ms, v.now_ms)}` : ""}</span>
                  <StatusPill status={v.status} />
                  <ChevronRight aria-hidden className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>
    </AppShell>
  );
}
