"use client";
// D25: anyone can pay for anyone's plan tier. An owner sends this link to a
// relative (or Behest to a customer); the payer picks a tier and pays in USDC,
// test USDC, or any asset through NEAR Intents. Paying never changes the plan.
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BadgeCheck, HandCoins } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { PayTierDialog, TierLadder } from "@/components/Tiers";
import { Button, ButtonLink, EmptyState, Notice, Skeleton } from "@/components/ui";
import { formatFee, useTier, useTierConfig } from "@/lib/tiers";

export default function PayPage() {
  return (
    <Suspense>
      <Pay />
    </Suspense>
  );
}

function Pay() {
  const params = useParams<{ owner: string }>();
  const search = useSearchParams();
  const owner = decodeURIComponent(params.owner ?? "").toLowerCase();
  const cfg = useTierConfig();
  const { tier, error, reload } = useTier(owner);
  const wanted = Number(search.get("tier"));
  const [pay, setPay] = useState<number | null>(null);

  if (error) return <AppShell><EmptyState tone="error" icon={HandCoins} title="Couldn't read this plan's tier" body="The network didn't answer. Try again in a moment." /></AppShell>;
  if (!cfg || !tier) return <AppShell><Skeleton className="h-96 w-full rounded-card" /></AppShell>;
  if (!tier.enabled) return <AppShell><EmptyState icon={BadgeCheck} title="Every plan is free here" body="This deployment doesn't charge for tiers." /></AppShell>;

  const top = cfg.tiers.length - 1;
  const suggested = Number.isInteger(wanted) && wanted > tier.tier && wanted <= top ? wanted : Math.min(top, Math.max(tier.tier + 1, tier.required));
  return (
    <AppShell>
      <div className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <HandCoins aria-hidden className="size-4" />
          Pay for a plan
        </span>
        <h1 className="text-[clamp(36px,5.5vw,64px)] font-medium leading-[0.95] tracking-[-0.045em]">
          A gift for <span className="break-all font-mono text-[0.6em] tracking-normal">{owner}</span>
        </h1>
        <p className="max-w-[680px] text-lg leading-relaxed text-muted">
          You&apos;re paying Behest&apos;s one-time fee for this person&apos;s inheritance plan. It goes to Behest, not into the plan, and it can&apos;t change who inherits or what.
          {BigInt(tier.paid) > 0n ? ` ${formatFee(cfg, tier.paid)} has been paid so far.` : ""}
        </p>
      </div>
      {tier.tier >= top ? (
        <Notice tone="ok" title={`Already on ${cfg.tiers[top]!.name}`}>
          Nothing more to pay. Thank you for thinking of them.
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="lg" onClick={() => setPay(suggested)}>
            Pay for {cfg.tiers[suggested]!.name}
          </Button>
          <ButtonLink href={`/plan/${encodeURIComponent(owner)}`} variant="outline" size="lg">
            See the plan
          </ButtonLink>
        </div>
      )}
      <TierLadder cfg={cfg} current={tier.tier} need={tier.required} onPick={setPay} />
      {pay !== null && <PayTierDialog cfg={cfg} owner={owner} target={pay} tier={tier} onClose={() => setPay(null)} onPaid={reload} />}
    </AppShell>
  );
}
