"use client";
// The public inspector: everything about a plan, read straight from the chain.
import { Braces, Landmark, ScrollText } from "lucide-react";
import { CONTRACT_ID, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { nextStep } from "@/lib/guide";
import { actionsFor, describePlan, duration, formatEth, formatNear, formatToken, relative, shortName, when } from "@/lib/plan";
import { useVault } from "@/lib/vault";
import { Address, CopyButton, Disclosure, Term } from "../interactive";
import { GuardianList, HeirList, Row, Timeline } from "../PlanParts";
import { OptionsCard } from "../ReleaseOptions";
import { RulesCard } from "../ReleaseRules";
import { HistoryCard } from "../Rounds";
import { GuardianHealthCard } from "../Recovery";
import { useTx } from "../tx";
import { CanAct, Card, SectionTitle, Skeleton } from "../ui";
import { Group, NowCard, ProposalPanel, type PlanCtx } from "./common";

export function PublicView({ ctx }: { ctx: PlanCtx }) {
  const { view, now, refresh, rules, history, options, me } = ctx;
  const { busy, act } = useTx(refresh);
  const vault = useVault(view.plan.owner);
  const p = view.plan.policy;
  const step = nextStep(view, "public", { now, me });
  return (
    <>
      <NowCard step={step} now={now} role="public">
        <div className="w-full">
          <CanAct actions={actionsFor(view, "public")} />
        </div>
      </NowCard>
      <Card className="flex flex-col gap-5">
        <SectionTitle icon={ScrollText} title="In plain words" />
        <p className="text-lg leading-snug tracking-[-0.01em]">{describePlan(p, shortName(view.plan.owner))}</p>
        <Timeline view={view} now={now} />
      </Card>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <SectionTitle icon={Landmark} title="Rules as stored on-chain" />
          <div>
            <Row k={<Term k="checkIn">Check-in interval</Term>} v={duration(p.check_in_interval_ms)} />
            <Row k={<Term k="grace">Grace period</Term>} v={duration(p.grace_ms)} />
            <Row k={<Term k="waiting">Waiting period</Term>} v={duration(p.waiting_period_ms)} />
            <Row k={<Term k="quorum">Quorum</Term>} v={`${p.quorum} of ${p.guardians.length} guardians`} />
            <Row k="Last check-in" v={`${when(view.plan.last_check_in_ms)} (${relative(view.plan.last_check_in_ms, now)})`} />
            <Row k={<Term k="unreachable">Unreachable from</Term>} v={`${when(view.overdue_at_ms)} (${relative(view.overdue_at_ms, now)})`} />
            <Row k="Plan version" v={view.plan.version} />
            <Row k={<Term k="escrow">NEAR escrow</Term>} v={`${formatNear(view.plan.escrow)} NEAR`} />
            <Row k={<Term k="vault">ETH vault</Term>} v={vault ? <Address value={vault.address} href={`${ETH_EXPLORER}/address/${vault.address}`} label="Ethereum vault" /> : <Skeleton className="h-4 w-40" />} />
            <Row k="Vault balance" v={vault?.balance != null ? `${formatEth(vault.balance)} ETH` : <Skeleton className="h-4 w-24" />} />
            {vault?.tokens.map(({ token, balance }) => (
              <Row key={token.address} k={`Vault ${token.symbol}`} v={balance != null ? `${formatToken(balance, token)} ${token.symbol}` : "…"} />
            ))}
            <Row k="Vault next nonce" v={view.plan.eth_next_nonce} />
            <Row k="Contract" v={<Address value={CONTRACT_ID} href={`${NEAR_EXPLORER}/address/${CONTRACT_ID}`} label="contract" />} />
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          <HeirList view={view} me={me} />
          <GuardianList view={view} me={me} />
        </div>
      </div>
      {view.plan.proposal && <ProposalPanel view={view} now={now} me={me} technical />}
      <GuardianHealthCard planView={view} rec={ctx.recovery} me={me} now={now} editable={false} />
      <Group title="Rules and history">
        <RulesCard view={view} now={now} rules={rules.rules} editable={false} act={act} busy={!!busy} signedIn={!!me} />
        <OptionsCard view={view} now={now} me={me} editable={false} act={act} busy={!!busy} state={options} />
        <HistoryCard view={view} history={history} />
        <Disclosure icon={Braces} title="Raw contract view" sub="get_plan, as JSON" aside={<CopyButton value={JSON.stringify(view, null, 2)} label="Copy JSON" />}>
          <pre className="max-h-[480px] overflow-auto rounded-tile bg-void p-4 font-mono text-xs leading-relaxed text-white">{JSON.stringify(view, null, 2)}</pre>
        </Disclosure>
      </Group>
      <p className="text-center text-xs text-muted">Everything here is read directly from the chain and refreshes every few seconds.</p>
    </>
  );
}
