"use client";
// Guardian and delay-signer views: lead with the vote or proposal that needs
// them, then the timeline, the people and the plan's rules.
import { ArrowDown, ScrollText } from "lucide-react";
import { nextStep } from "@/lib/guide";
import { describePlan, shortName } from "@/lib/plan";
import { BtcRebase, useBtc } from "../Bitcoin";
import { GetNotified } from "../Notifications";
import { GuardianList, Timeline } from "../PlanParts";
import { ExtensionControls, OptionsCard } from "../ReleaseOptions";
import { RulesCard } from "../ReleaseRules";
import { HistoryCard, ProposeCard } from "../Rounds";
import { GuardianHealthCard, MySeatCard } from "../Recovery";
import { PlanSummaryCard } from "../Summary";
import { Heirs, RevealCard } from "../Sealed";
import { useTx } from "../tx";
import { Button, Card, SectionTitle } from "../ui";
import { Group, NowCard, ProposalPanel, type PlanCtx } from "./common";

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

function PlainWords({ ctx }: { ctx: PlanCtx }) {
  return (
    <Card className="flex flex-col gap-5">
      <SectionTitle icon={ScrollText} title="How this plan works" />
      <p className="text-lg leading-snug tracking-[-0.01em]">{describePlan(ctx.view.plan.policy, shortName(ctx.view.plan.owner))}</p>
      <Timeline view={ctx.view} now={ctx.now} />
    </Card>
  );
}

export function GuardianView({ ctx }: { ctx: PlanCtx }) {
  const { view, now, refresh, rules, history, options, me, followUp } = ctx;
  const { busy, act } = useTx(refresh);
  const btc = useBtc(view.plan.owner);
  const s = view.status;
  const p = view.plan.proposal;
  const step = nextStep(view, "guardian", { now, me, followUp });
  const voted = !!me && !!p && (p.approvals.includes(me) || p.rejections.includes(me));
  const canPropose = s === "Overdue" || s === "Settled";

  return (
    <>
      <NowCard step={step} now={now} role="guardian">
        {canPropose && (
          <Button variant="primary" size="lg" iconRight={ArrowDown} onClick={() => scrollTo("propose")}>
            {followUp || s === "Settled" ? "Review the follow-up" : "Review and propose"}
          </Button>
        )}
        {s === "Proposed" && !voted && (
          <Button variant="primary" size="lg" iconRight={ArrowDown} onClick={() => scrollTo("proposal")}>
            Review and vote
          </Button>
        )}
      </NowCard>
      {ctx.sealed.view && <RevealCard planView={view} sealed={ctx.sealed} me={me} onRevealed={refresh} />}
      {canPropose && <ProposeCard view={view} act={act} busy={!!busy} followUp={followUp} />}
      {p && <ProposalPanel view={view} now={now} me={me} act={act} busy={!!busy} vote />}
      <BtcRebase view={view} btc={btc} />
      {s === "Active" && <GetNotified role="guardian" />}
      {me && <MySeatCard owner={view.plan.owner} me={me} rec={ctx.recovery} now={now} />}
      <PlainWords ctx={ctx} />
      <Group title="People">
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <GuardianList view={view} me={me} />
          <Heirs view={view} sealed={ctx.sealed} />
        </div>
        <GuardianHealthCard planView={view} rec={ctx.recovery} me={me} now={now} editable={false} />
        <PlanSummaryCard ctx={ctx} role="guardian" />
      </Group>
      <Group title="Rules and history">
        <RulesCard view={view} now={now} rules={rules.rules} editable={false} act={act} busy={!!busy} signedIn />
        <OptionsCard view={view} now={now} me={me} editable={false} act={act} busy={!!busy} state={options} />
        <HistoryCard view={view} history={history} />
      </Group>
    </>
  );
}

export function DelayView({ ctx }: { ctx: PlanCtx }) {
  const { view, now, refresh, rules, history, options, me } = ctx;
  const { busy, act } = useTx(async () => {
    await refresh();
    await options.reload();
  });
  const p = view.plan.proposal;
  const o = options.options;
  const ext = options.ext;
  const waiting = view.status === "Waiting" && p?.waiting_ends_at_ms != null && now < p.waiting_ends_at_ms;
  const capLeft = !!o && o.max_total_extension_ms - (ext?.total_ms ?? 0) > 0;
  const step = nextStep(view, "delay", { now, me, delay: { pending: !!ext?.pending, voted: !!me && !!ext?.pending?.votes.includes(me), capLeft } });
  return (
    <>
      <NowCard step={step} now={now} role="delay" />
      {waiting && me && o && <ExtensionControls view={view} now={now} me={me} options={o} ext={ext} busy={!!busy} act={act} />}
      {p && <ProposalPanel view={view} now={now} me={me} />}
      <PlainWords ctx={ctx} />
      <Group title="Rules">
        <OptionsCard view={view} now={now} me={me} editable={false} act={act} busy={!!busy} state={options} defaultOpen controls={false} />
        <RulesCard view={view} now={now} rules={rules.rules} editable={false} act={act} busy={!!busy} signedIn />
        <HistoryCard view={view} history={history} />
      </Group>
      <Group title="People">
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <GuardianList view={view} me={me} />
          <Heirs view={view} sealed={ctx.sealed} />
        </div>
      </Group>
    </>
  );
}
