"use client";
// Landing hero buttons. Signed-in owners with a plan get check-in and their
// plan side by side, equally prominent; everyone else gets create / try.
import { ArrowRight, FlaskConical, HeartPulse } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getPlan } from "@/lib/contract";
import { useSession } from "@/lib/session";
import type { PlanView } from "@/lib/types";
import { Countdown } from "./interactive";
import { useTx } from "./tx";
import { Button, ButtonLink } from "./ui";

export function HeroActions() {
  const { session } = useSession();
  const me = session?.accountId ?? null;
  const [plan, setPlan] = useState<PlanView | null>(null);
  const load = useCallback(async () => {
    if (!me) return setPlan(null);
    setPlan(await getPlan(me).catch(() => null));
  }, [me]);
  useEffect(() => void load(), [load]);
  const { busy, act } = useTx(load);

  if (!plan)
    return (
      <>
        <div className="flex flex-wrap items-center gap-5">
          <ButtonLink href="/setup" variant="ink" size="lg" iconRight={ArrowRight}>
            Create a plan
          </ButtonLink>
          <ButtonLink href="/try" variant="subtle" size="lg" icon={FlaskConical}>
            Try it as a guardian or heir
          </ButtonLink>
        </div>
        <span className="text-base text-muted">No custody. No middlemen. Only the plan you wrote.</span>
      </>
    );

  const s = plan.status;
  const open = s === "Proposed" || s === "Waiting";
  const canCheckIn = s === "Active" || s === "Overdue" || open;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {canCheckIn && (
          <Button
            variant="primary"
            size="lg"
            icon={HeartPulse}
            loading={!!busy}
            onClick={() => act(open ? "Check in (cancels the release)" : "Check in", "check_in", {}, { done: open ? "You're here. The release is cancelled." : "Checked in. The clock has restarted." })}
          >
            {open ? "I'm here, check in and cancel" : "Check in now"}
          </Button>
        )}
        <ButtonLink href={`/plan/${encodeURIComponent(plan.plan.owner)}`} variant="ink" size="lg" iconRight={ArrowRight}>
          Open your plan
        </ButtonLink>
      </div>
      <span className="text-base text-muted">
        {s === "Active" ? <Countdown to={plan.overdue_at_ms} now={plan.now_ms} prefix="Next check-in due in " /> : s === "Overdue" ? "You've missed a check-in: guardians can now propose a release." : open ? "A release is under way. Checking in cancels it." : "Your plan is in its final stage."}
      </span>
    </>
  );
}
