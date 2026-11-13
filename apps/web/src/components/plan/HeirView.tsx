"use client";
// The heir's journey (design "Waiting · heir · mobile"): plain words, one big
// action when it's time, a tracker as each part lands. Hashes only under
// "Technical details".
import { ArrowRight, CircleHelp, FileText, Gift, RotateCcw, Wrench } from "lucide-react";
import { useState } from "react";
import { CONTRACT_ID } from "@/lib/config";
import { useBtcQuote, useConfig, useEthQuote } from "@/lib/fees";
import { nextStep, TRANSFER_PROGRESS } from "@/lib/guide";
import { assetLabel, failureText, formatAmount, formatBtc, formatEth, isBtc, isEvm, shortName, when } from "@/lib/plan";
import type { Transfer } from "@/lib/types";
import { useVault } from "@/lib/vault";
import { useConfirm } from "../feedback";
import { HeirIntentsCard, useIntentsHolding } from "../Intents";
import { EmailAccountCard } from "../EmailAccount";
import { GetNotified } from "../Notifications";
import { Countdown, Dialog, Disclosure, Term } from "../interactive";
import { Row, Timeline, receiptUrl } from "../PlanParts";
import { OptionsCard } from "../ReleaseOptions";
import { RulesCard } from "../ReleaseRules";
import { HistoryCard, ProposeCard } from "../Rounds";
import { GuardianHealthCard } from "../Recovery";
import { MyDestinationsCard } from "../Destinations";
import { PlanSummaryCard } from "../Summary";
import { useTx } from "../tx";
import { Button, ButtonLink, ExtLink, Progress, TickerDisc, TransferPill, cx } from "../ui";
import type { PlanCtx } from "./common";

const tickerOf = (t: Transfer) => (isBtc(t.asset) ? "BTC" : isEvm(t.asset) ? "ETH" : "NEAR");

export function HeirView({ ctx }: { ctx: PlanCtx }) {
  const { view, now, refresh, rules, history, options, me, followUp } = ctx;
  const confirm = useConfirm();
  const { busy, act } = useTx(refresh);
  const [help, setHelp] = useState(false);
  const owner = shortName(view.plan.owner);
  const s = view.status;
  const p = view.plan.proposal;
  const heir = view.plan.policy.heirs.find((h) => h.account_id === me);
  const mine = p?.transfers.map((t, index) => ({ t, index })).filter(({ t }) => t.heir === me) ?? [];
  const started = mine.some(({ t }) => t.state !== "Pending");
  const pendingMine = mine.filter(({ t }) => t.state === "Pending");
  const cfg = useConfig();
  // D27: NEAR and NEP-141 shares may be paid into the heir's NEAR Intents account instead.
  const intents = useIntentsHolding(view.plan.owner, me ?? null, heir?.near_destination);
  const viaIntents = (t: Transfer) => !!intents.target && !isEvm(t.asset) && !isBtc(t.asset);
  const heirVault = useVault(view.plan.owner);
  const evmTxs = pendingMine.filter(({ t }) => isEvm(t.asset)).map(({ t }) => ({ to: t.destination as `0x${string}`, token: typeof t.asset === "object" && "Erc20" in t.asset ? (t.asset.Erc20 as `0x${string}`) : undefined }));
  const btcPending = pendingMine.filter(({ t }) => t.asset === "Btc").length;
  const ethFees = useEthQuote(cfg, heirVault?.address ?? null, evmTxs);
  const btcFees = useBtcQuote(cfg, btcPending, btcPending ? 1 : 0);
  const ready = p?.waiting_ends_at_ms;
  const step = nextStep(view, "heir", { now, me, followUp });
  const canReceive = (s === "Eligible" || s === "Executing") && pendingMine.length > 0;
  const fees = [ethFees && `≈ ${formatEth(ethFees.total)} ETH`, btcFees && `≈ ${formatBtc(btcFees.likely)} BTC`].filter(Boolean).join(" and ");

  const claim = async () => {
    const ok = await confirm({
      title: `Receive ${pendingMine.map(({ t }) => formatAmount(t)).join(" and ")}?`,
      body: `It goes where ${owner} chose${pendingMine.some(({ t }) => viaIntents(t)) ? ", including your NEAR Intents account" : ""}. Once sent, transfers can't be reversed.`,
      rows: [
        ...pendingMine.map(({ t }): [string, React.ReactNode] => {
          const to = viaIntents(t) ? intents.target! : t.destination;
          return [viaIntents(t) ? `${assetLabel(t.asset)} into NEAR Intents` : `${assetLabel(t.asset)} to`, <span key={t.destination} className="font-mono text-xs">{to.length > 20 ? `${to.slice(0, 8)}…${to.slice(-6)}` : to}</span>];
        }),
        ["Network fee", fees ? `${fees}, prepaid by the plan` : "Prepaid by the plan"],
      ],
      confirmLabel: "Receive my share",
    });
    if (ok) await act("Receive", "claim", { owner: view.plan.owner }, { tgas: 300, done: "On its way. This page updates as each transfer lands." });
  };
  const retry = (index: number) => act("Retry", "retry_transfer", { owner: view.plan.owner, index }, { tgas: 300, done: "Retrying. This page updates as it lands." }).then((ok) => (ok && intents.reload(), ok));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      {/* What the heir came for stays in view on desktop; details sit beside it. */}
      <div className="flex flex-col gap-6 lg:sticky lg:top-6">
        <div className="flex flex-col gap-3">
          <h2 key={step.title} className="animate-fade-up text-[clamp(34px,8vw,44px)] font-medium leading-[0.98] tracking-[-0.04em]">
            {step.title}
          </h2>
          <p className="text-[17px] leading-relaxed text-muted">{step.body}</p>
        </div>

        <section aria-label="Set aside for you" className="rounded-row border border-line bg-subtle px-1 pb-1">
          <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
            <Gift aria-hidden className="size-4 text-muted" />
            Set aside for you
          </div>
          <div className="flex flex-col gap-2 rounded-tile border border-line bg-card p-4">
            <span className="text-[28px] font-medium leading-none tracking-[-0.03em]">
              {heir ? `${(heir.share_bps / 100).toFixed(heir.share_bps % 100 ? 2 : 0)}% of ${owner}'s plan` : mine.length ? `A share passed to you` : "—"}
            </span>
            <span className="text-[15px] leading-normal text-muted">
              {mine.length ? mine.map(({ t }) => formatAmount(t)).join(" + ") : p ? `Nothing for you in release #${p.id}.` : "Amounts are fixed when a release is proposed."}
              {heir?.eth_destination && <> · Ethereum wallet ending in <strong className="text-ink">{heir.eth_destination.slice(-4).toUpperCase()}</strong></>}
              {heir?.near_destination && (
                <>
                  {" "}
                  · {/^[0-9a-f]{64}$/.test(heir.near_destination) ? "NEAR account ending in " : "NEAR account "}
                  <strong className="text-ink">{/^[0-9a-f]{64}$/.test(heir.near_destination) ? heir.near_destination.slice(-4).toUpperCase() : heir.near_destination.split(".")[0]}</strong>
                </>
              )}
              {mine.length > 0 && " · fees paid"}
            </span>
          </div>
        </section>

        {s === "Waiting" && ready && (
          <div className="flex animate-fade-up flex-wrap items-center justify-between gap-2 rounded-tile bg-gradient-to-b from-[#A9CCFF] to-[#6E9BFF] px-5 py-4 text-[#0A0A0A]">
            <span className="flex flex-col">
              <span className="text-[15px]">Ready from</span>
              <span className="text-2xl font-medium tracking-[-0.02em]">{new Date(ready).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            </span>
            <Countdown to={ready} now={now} className="rounded-full bg-white/40 px-3 py-1.5 text-sm font-semibold" prefix="in " />
          </div>
        )}

        {canReceive && (
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" className="min-h-14 w-full text-lg" icon={Gift} loading={busy === "Receive"} disabled={!!busy && busy !== "Receive"} onClick={claim}>
              Receive my share
            </Button>
            {fees && (
              <p className="text-center text-sm text-muted">
                <Term k="feeReserve">Network fees</Term> come from the plan&apos;s reserve, not your share: {fees}.
              </p>
            )}
          </div>
        )}

        {started && (
          <section aria-label="Your transfers" className="flex flex-col gap-2">
            <h3 className="px-1 text-sm font-semibold text-muted">Your transfers</h3>
            <ul className="flex flex-col gap-2">
              {mine.map(({ t, index }) => {
                const url = receiptUrl(t);
                return (
                  <li key={index} className="flex animate-fade-up flex-col gap-3 rounded-row border border-line bg-card p-4">
                    <div className="flex items-center gap-3">
                      <TickerDisc ticker={tickerOf(t)} size={40} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="text-[17px] font-semibold">{formatAmount(t)}</span>
                        <Progress value={TRANSFER_PROGRESS[t.state]} tone={t.state === "Failed" ? "error" : t.state === "Confirmed" ? "ok" : "signal"} label={`${formatAmount(t)} progress`} />
                      </div>
                      <TransferPill state={t.state} />
                    </div>
                    {t.state === "Failed" && (
                      <div className="flex flex-col gap-3 rounded-tile bg-error-bg p-3 text-sm text-error">
                        <p className="leading-relaxed">{failureText(t)}</p>
                        <div className="grid grid-cols-2 gap-2 text-ink">
                          <span className="flex flex-col rounded-tile bg-card p-2.5">
                            <span className="text-xs text-muted">Your funds</span>
                            <span className="font-semibold">Safe in the plan</span>
                          </span>
                          <span className="flex flex-col rounded-tile bg-card p-2.5">
                            <span className="text-xs text-muted">Address</span>
                            <span className="font-semibold">Unchanged</span>
                          </span>
                        </div>
                        {!["GasLimitTooLow", "Reverted"].includes(t.failure ?? "") && (
                          <Button variant="ink" size="sm" icon={RotateCcw} className="self-start" disabled={!!busy} onClick={() => retry(index)}>
                            Try again
                          </Button>
                        )}
                      </div>
                    )}
                    {url && (
                      <ExtLink href={url} className="self-start text-sm font-semibold">
                        View receipt
                      </ExtLink>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <Button variant="subtle" size="lg" icon={CircleHelp} className="w-full" onClick={() => setHelp(true)}>
          What happens next?
        </Button>
        {heir && (
          <ButtonLink href={`/plan/${encodeURIComponent(view.plan.owner)}/packet?heir=${encodeURIComponent(heir.account_id)}`} variant="outline" size="lg" icon={FileText} className="w-full">
            Recovery packet to print and keep
          </ButtonLink>
        )}
      </div>
      <div className="flex flex-col gap-6">
        <EmailAccountCard />
        {me && <MyDestinationsCard planView={view} me={me} dest={ctx.destinations} />}
        <HeirIntentsCard owner={view.plan.owner} holding={intents} />
        <GetNotified role="heir" />
        {followUp && <ProposeCard view={view} act={act} busy={!!busy} followUp asHeir />}
        <HistoryCard view={view} history={history} />
        <PlanSummaryCard ctx={ctx} role="heir" />
        <GuardianHealthCard planView={view} rec={ctx.recovery} me={me} now={now} editable={false} />
        <RulesCard view={view} now={now} rules={rules.rules} editable={false} act={act} busy={!!busy} signedIn />
        <OptionsCard view={view} now={now} me={me} editable={false} act={act} busy={!!busy} state={options} />
        <Disclosure icon={Wrench} title="Technical details" sub="Accounts, destinations and transaction hashes">
          <div>
            <Row k="Plan" v={view.plan.owner} mono />
            <Row k="Contract" v={CONTRACT_ID} mono />
            {mine.map(({ t, index }) => (
              <Row key={index} k={`${assetLabel(t.asset)} transfer #${index}`} v={`${t.destination}${t.tx_hash ? ` · ${t.tx_hash}` : ""}${t.eth_tx ? ` · nonce ${t.eth_tx.nonce}` : ""}`} mono />
            ))}
          </div>
        </Disclosure>
      </div>
      <Dialog open={help} onClose={() => setHelp(false)} title="What happens next" description={`How a release of ${owner}'s plan reaches you.`} sheet bottom>
        <Timeline view={view} now={now} />
        <ol className="flex flex-col gap-3 text-[15px] leading-relaxed">
          {[
            `If ${owner} stops checking in, their guardians can propose a release. Behest never assumes more than that.`,
            `Enough guardians approve, then a waiting period runs. ${owner} can stop it at any point until it ends.`,
            `When it ends, you can receive your share${options.options?.mode === "Automatic" ? " (it starts by itself in this plan)" : ""}. It goes only to the addresses ${owner} chose.`,
            "Network fees come out of the plan, not your share. Nobody can redirect your share.",
          ].map((t, i) => (
            <li key={i} className={cx("flex gap-3")}>
              <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-subtle text-sm font-semibold">
                {i + 1}
              </span>
              {t}
            </li>
          ))}
        </ol>
        {ready && s === "Waiting" && <p className="text-sm text-muted">Ready from {when(ready)}.</p>}
        <a href="/#faq" className="inline-flex items-center gap-1 self-start text-sm font-semibold text-signal-text underline underline-offset-4">
          Read the FAQ <ArrowRight aria-hidden className="size-4" />
        </a>
      </Dialog>
    </div>
  );
}
