"use client";
// D25: plan tiers. The ladder (what each tier unlocks and costs), the owner's
// tier card with a plain fee breakdown (service fee, storage, chain fees kept
// apart), and the payment dialog: test USDC on testnet, USDC from a NEAR
// wallet, or any asset through NEAR Intents on mainnet. Anyone can pay for
// anyone's plan, so the dialog also hands out a link to send to a relative.
import { BadgeCheck, Check, Coins, Gift, Link2, Receipt, Sparkles, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CONTRACT_ID } from "@/lib/config";
import { getConfig, getSponsorship, type Sponsorship } from "@/lib/contract";
import { humanError } from "@/lib/hooks";
import { intentTokens, intentsAvailable, quote, status as intentStatus, STATUS_WORDS, type IntentQuote, type IntentStatus, type IntentToken } from "@/lib/intents";
import { formatEth, formatNear } from "@/lib/plan";
import { useSession } from "@/lib/session";
import {
  feeBalance,
  formatFee,
  formatUsd,
  isTestnet,
  mintTest,
  payByFaucet,
  payFromWallet,
  payable,
  tierPerks,
  getTreasury,
  useTier,
  useTierConfig,
  type TierConfig,
  type TierView,
  type TreasuryView,
} from "@/lib/tiers";
import type { PlanView } from "@/lib/types";
import { useToast } from "./feedback";
import { CopyButton, Dialog, Disclosure, Field, Segmented } from "./interactive";
import { QrCode } from "./QrCode";
import { Button, Card, Notice, SectionTitle, Skeleton, cx, inputClass } from "./ui";

// ------------------------------------------------------------------ ladder

/** The tiers side by side. `current` is highlighted; `need` marks the one a plan requires. */
export function TierLadder({ cfg, current, need, onPick, compact }: { cfg: TierConfig; current?: number; need?: number; onPick?: (t: number) => void; compact?: boolean }) {
  return (
    <ul className={cx("grid grid-cols-1 gap-3", cfg.tiers.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
      {cfg.tiers.map((s, i) => {
        const mine = current === i;
        const needed = need === i && current !== undefined && need > current;
        return (
          <li key={s.name} className={cx("flex flex-col gap-3 rounded-card border p-5", mine ? "border-signal bg-s-approved" : needed ? "border-warn" : "border-line bg-card")}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[17px] font-semibold">{s.name}</span>
              {mine && <span className="rounded-tag bg-ok-bg px-2 py-0.5 text-xs font-semibold text-ok">Yours</span>}
              {needed && <span className="rounded-tag bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn">Needed</span>}
            </div>
            <span className="text-3xl font-semibold tracking-[-0.02em]">
              {BigInt(s.price) > 0n ? formatUsd(s.price, cfg.fee_decimals) : "$0"}
              <span className="ml-1.5 text-sm font-normal text-muted">{BigInt(s.price) > 0n ? "once" : "forever"}</span>
            </span>
            {!compact && (
              <ul className="flex flex-col gap-1.5 text-sm">
                {tierPerks(s).map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
                    {p}
                  </li>
                ))}
              </ul>
            )}
            {onPick && current !== undefined && i > current && (
              <Button variant={needed ? "primary" : "outline"} size="sm" className="mt-auto" onClick={() => onPick(i)}>
                Upgrade to {s.name}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Pricing for the landing page: reads the live schedule, falls back to nothing. */
export function Pricing() {
  const cfg = useTierConfig();
  if (!cfg) return <Skeleton className="h-64 w-full rounded-card" />;
  return (
    <div className="flex flex-col gap-4">
      <TierLadder cfg={cfg} />
      <p className="text-sm leading-relaxed text-muted">
        Paid once, in USDC, by you or anyone on your behalf. Moving up costs only the difference, and a plan you simplify keeps what you paid for. A tier limits what you can save, never a release:
        your heirs can always inherit. Behest pays the storage and gas for every plan.
        {intentsAvailable ? " Pay with almost any asset on almost any chain through NEAR Intents." : " On testnet, payments use free test USDC."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- owner card

/** The owner's tier, what the plan uses, and every cost kept in its own line. */
export function TierCard({ view, editable }: { view: PlanView; editable: boolean }) {
  const owner = view.plan.owner;
  const cfg = useTierConfig();
  const { tier, reload } = useTier(owner);
  const [pay, setPay] = useState<number | null>(null);
  const [sponsor, setSponsor] = useState<{ s: Sponsorship | null; allowance: bigint } | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getSponsorship(owner), getConfig()])
      .then(([s, c]) => live && setSponsor({ s, allowance: BigInt((c as { sponsor?: { allowance_per_owner: string } }).sponsor?.allowance_per_owner ?? "0") }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [owner]);

  if (!cfg || !tier) return <Skeleton className="h-48 w-full rounded-card" />;
  if (!tier.enabled) return null;
  const spec = cfg.tiers[tier.tier]!;
  const grandfathered = tier.required > tier.tier;
  const storageUsed = sponsor?.s ? sponsor.allowance - BigInt(sponsor.s.allowance_left) : 0n;
  const proposal = view.plan.proposal;

  return (
    <Card className="flex flex-col gap-5">
      <SectionTitle
        icon={BadgeCheck}
        title={`${spec.name} plan`}
        sub={BigInt(tier.paid) > 0n ? `${formatFee(cfg, tier.paid)} paid toward tiers` : "Nothing paid. Free plans stay free."}
        aside={
          editable && tier.tier < cfg.tiers.length - 1 ? (
            <Button size="sm" variant="outline" icon={Sparkles} onClick={() => setPay(tier.tier + 1)}>
              Upgrade
            </Button>
          ) : undefined
        }
      />
      {grandfathered && (
        <Notice tone="info">
          This plan uses {cfg.tiers[tier.required]!.name} features from before tiers existed. You can keep editing it at that level; adding more needs an upgrade.
        </Notice>
      )}
      <TierLadder cfg={cfg} current={tier.tier} need={tier.required} onPick={editable ? setPay : undefined} compact />
      <Disclosure icon={Receipt} title="What you've paid, and what for" sub="Behest's fee and the networks' fees are separate.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="font-semibold">Service fee</dt>
          <dd>
            {BigInt(tier.paid) > 0n ? formatFee(cfg, tier.paid) : "None"} to Behest, once, for the {spec.name} tier. It goes to Behest&apos;s treasury, never into your plan or anyone&apos;s inheritance.
          </dd>
          <dt className="font-semibold">Storage</dt>
          <dd>
            {sponsor?.s && storageUsed > 0n ? `${formatNear(storageUsed.toString())} NEAR of plan storage covered by Behest's sponsor pool.` : "Paid with your own NEAR when you saved, or not used yet."} It stays locked on NEAR while
            the plan exists.
          </dd>
          <dt className="font-semibold">Network fees</dt>
          <dd>
            {proposal && BigInt(proposal.eth_fee_reserve) > 0n
              ? `${formatEth(proposal.eth_fee_reserve)} ETH of this release is reserved for Ethereum gas, paid from the vault to the network, not to Behest.`
              : "Ethereum and Bitcoin transfers pay their own network fees from the vault when a release happens. Behest takes none of it."}{" "}
            NEAR gas for you, guardians and heirs is paid by Behest.
          </dd>
        </dl>
      </Disclosure>
      {pay !== null && <PayTierDialog cfg={cfg} owner={owner} target={pay} tier={tier} onClose={() => setPay(null)} onPaid={reload} />}
    </Card>
  );
}

// -------------------------------------------------------------- pay dialog

type Method = "test" | "wallet" | "intents" | "share";

export function PayTierDialog({ cfg, owner, target, tier, onClose, onPaid }: { cfg: TierConfig; owner: string; target: number; tier: TierView; onClose: () => void; onPaid: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const spec = cfg.tiers[target]!;
  const due = payable(cfg, BigInt(tier.due[target] ?? "0"), BigInt(tier.paid));
  const nearSigner = !!session && session.kind !== "evm";
  const methods = useMemo(() => {
    const m: { value: Method; label: string }[] = [];
    if (isTestnet) m.push({ value: "test", label: "Test USDC" });
    if (nearSigner) m.push({ value: "wallet", label: "USDC in my wallet" });
    if (intentsAvailable) m.push({ value: "intents", label: "Any asset" });
    m.push({ value: "share", label: "Ask someone" });
    return m;
  }, [nearSigner]);
  const [method, setMethod] = useState<Method>(methods[0]!.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  useEffect(() => {
    if (!session || session.kind === "evm") return;
    feeBalance(cfg, session.accountId).then(setBalance, () => {});
  }, [cfg, session]);

  const done = useCallback(() => {
    if (session?.dao) {
      // D26: the DAO pays from its own USDC once its council approves the ft_transfer_call proposal.
      toast.show({ tone: "ok", title: `Payment proposed to ${session.dao.id}`, body: `The ${spec.name} tier is paid from the DAO's USDC once the council approves. Vote on it from the plan page.` });
      onPaid();
      onClose();
      return;
    }
    toast.show({ tone: "ok", title: `${spec.name} tier paid`, body: "The plan can now use everything in it." });
    onPaid();
    onClose();
  }, [onClose, onPaid, spec.name, toast, session]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      done();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const payTest = () =>
    run(async () => {
      if (nearSigner && session) {
        await mintTest(session, cfg, session.accountId, due);
        await payFromWallet(session, cfg, owner, due);
      } else {
        await payByFaucet(owner, target);
      }
    });
  const payWallet = () => run(async () => session && payFromWallet(session, cfg, owner, due));
  const link = typeof window !== "undefined" ? `${window.location.origin}/pay/${encodeURIComponent(owner)}?tier=${target}` : `/pay/${owner}?tier=${target}`;
  const mine = session?.accountId === owner;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`${spec.name}: ${formatFee(cfg, due)}`}
      description={
        <>
          {BigInt(tier.paid) > 0n ? `What's left after the ${formatFee(cfg, tier.paid)} already paid. ` : ""}Paid once, for {mine ? "your plan" : <span className="font-mono">{owner}</span>}. It goes to Behest, not into the plan.
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-1.5 text-sm">
          {tierPerks(spec).map((p) => (
            <li key={p} className="flex items-start gap-2">
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
              {p}
            </li>
          ))}
        </ul>
        {methods.length > 1 && <Segmented label="How to pay" options={methods} value={method} onChange={setMethod} size="sm" />}

        {method === "test" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted">
              Testnet USDC is free. {nearSigner ? "Your account takes it from the test faucet and pays it, two quick transactions." : "Behest's test faucet pays it for this plan; you don't sign anything."}
            </p>
            <Button variant="primary" icon={Gift} loading={busy} onClick={payTest}>
              Pay {formatFee(cfg, due)} in test USDC
            </Button>
          </div>
        )}

        {method === "wallet" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              You hold {balance === null ? "…" : formatFee(cfg, balance)} in <span className="font-mono">{session?.accountId}</span>.
            </p>
            <Button variant="primary" icon={Wallet} loading={busy} disabled={balance !== null && balance < due} onClick={payWallet}>
              Pay {formatFee(cfg, due)}
            </Button>
            {balance !== null && balance < due && <Notice tone="warn">Not enough USDC in this account.{isTestnet ? " Use Test USDC instead." : " Use Any asset to pay from another chain."}</Notice>}
          </div>
        )}

        {method === "intents" && cfg.fee_token && <IntentsPay feeToken={cfg.fee_token} amount={due} owner={owner} onDone={done} />}

        {method === "share" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted">Anyone can pay for this plan: a relative, a friend, an employer. Send them this link. Nothing they pay can change the plan or reach your heirs.</p>
            <div className="flex items-center gap-2 rounded-row bg-subtle p-3">
              <Link2 aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
              <CopyButton value={link} />
            </div>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------- NEAR Intents (mainnet)

function IntentsPay({ feeToken, amount, owner, onDone }: { feeToken: string; amount: bigint; owner: string; onDone: () => void }) {
  const { session } = useSession();
  const [tokens, setTokens] = useState<IntentToken[] | null>(null);
  const [asset, setAsset] = useState("");
  const [refundTo, setRefundTo] = useState(session?.kind === "evm" ? session.accountId : "");
  const [q, setQ] = useState<IntentQuote | null>(null);
  const [st, setSt] = useState<IntentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    intentTokens().then((t) => {
      setTokens(t);
      setAsset((a) => a || t[0]?.assetId || "");
    }, (e) => setError(humanError(e)));
  }, []);

  useEffect(() => {
    if (!q?.depositAddress) return;
    let live = true;
    const tick = async () => {
      const s = await intentStatus(q.depositAddress).catch(() => null);
      if (!live || !s) return;
      setSt(s);
      if (s === "SUCCESS") onDone();
    };
    const id = setInterval(tick, 5_000);
    void tick();
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [q, onDone]);

  const origin = tokens?.find((t) => t.assetId === asset);
  async function getQuote() {
    if (!origin) return;
    setBusy(true);
    setError(null);
    try {
      setQ(await quote({ origin, feeToken, amount, owner, refundTo }));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!tokens) return error ? <Notice tone="error">{error}</Notice> : <Skeleton className="h-32 w-full" />;
  if (q) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-row bg-subtle p-4 sm:flex-row sm:items-start">
          <QrCode value={q.depositAddress} label="Deposit address" className="size-32 shrink-0" />
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <span>
              Send exactly <strong className="font-mono">{q.amountInFormatted} {origin?.symbol}</strong> on {origin?.blockchain} to:
            </span>
            <span className="flex items-center gap-2">
              <span className="min-w-0 break-all font-mono text-xs">{q.depositAddress}</span>
              <CopyButton value={q.depositAddress} />
            </span>
            {q.depositMemo && <span>Memo: <span className="font-mono">{q.depositMemo}</span></span>}
            <span className="text-muted">≈ ${Number(q.amountInUsd).toFixed(2)} · usually {Math.max(1, Math.round(q.timeEstimate / 60))} min · before {new Date(q.deadline).toLocaleTimeString()}</span>
          </div>
        </div>
        <Notice tone={st === "REFUNDED" || st === "FAILED" ? "warn" : st === "SUCCESS" ? "ok" : "info"}>{STATUS_WORDS[st ?? "PENDING_DEPOSIT"]}</Notice>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted">
        NEAR Intents swaps what you send into USDC and pays Behest for this plan in one step. If it can&apos;t, it refunds you on the chain you paid from.
      </p>
      <Field label="Pay with">
        {(p) => (
          <select {...p} className={inputClass} value={asset} onChange={(e) => setAsset(e.target.value)}>
            {tokens.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.symbol} on {t.blockchain}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Refund address" hint={`Your ${origin?.blockchain ?? ""} address, in case the swap can't complete.`}>
        {(p) => <input {...p} className={cx(inputClass, "font-mono")} value={refundTo} onChange={(e) => setRefundTo(e.target.value)} spellCheck={false} />}
      </Field>
      <Button variant="primary" icon={Coins} loading={busy} disabled={!refundTo.trim()} onClick={getQuote}>
        Get deposit address
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** Small inline banner for editors: this change needs a tier the owner hasn't paid for. */
export function TierNeeded({ cfg, owner, need, tier, onPaid, reason }: { cfg: TierConfig; owner: string; need: number; tier: TierView; onPaid: () => void; reason?: string | null }) {
  const [open, setOpen] = useState(false);
  const spec = cfg.tiers[need]!;
  return (
    <>
      <Notice
        tone="warn"
        title={`This needs the ${spec.name} tier`}
        action={
          <Button size="sm" variant="primary" icon={Sparkles} onClick={() => setOpen(true)}>
            Upgrade for {formatFee(cfg, payable(cfg, BigInt(tier.due[need] ?? "0"), BigInt(tier.paid)))}
          </Button>
        }
      >
        {reason ? `It uses ${reason}. ` : ""}Paid once; upgrading later costs only the difference.
      </Notice>
      {open && <PayTierDialog cfg={cfg} owner={owner} target={need} tier={tier} onClose={() => setOpen(false)} onPaid={onPaid} />}
    </>
  );
}

/** Inspect: Behest's fee revenue, which the contract keeps apart from every plan. */
export function TreasuryCard() {
  const cfg = useTierConfig();
  const [t, setT] = useState<TreasuryView | null>(null);
  useEffect(() => {
    getTreasury().then(setT, () => {});
  }, []);
  if (!cfg?.fee_token || !t) return null;
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={Receipt} title="Behest's fees, in the open" sub="Tier payments land in a treasury the contract keeps apart from plan escrow, network-fee reserves and the storage sponsor pool." />
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div className="flex flex-col gap-0.5"><dt className="text-muted">Collected</dt><dd className="font-mono">{formatFee(cfg, t.collected)}</dd></div>
        <div className="flex flex-col gap-0.5"><dt className="text-muted">Payments</dt><dd className="font-mono">{t.payments}</dd></div>
        <div className="flex flex-col gap-0.5"><dt className="text-muted">Paid out to Behest</dt><dd className="font-mono">{formatFee(cfg, t.withdrawn)}</dd></div>
        <div className="flex flex-col gap-0.5"><dt className="text-muted">Held now</dt><dd className="font-mono">{formatFee(cfg, t.balance)}</dd></div>
      </dl>
      <span className="text-xs text-muted">
        Fee token <span className="font-mono">{cfg.fee_token}</span>. Read from <span className="font-mono">get_treasury</span> on {CONTRACT_ID}; only the admin can pay it out, and never from a plan.
      </span>
    </Card>
  );
}
