"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { parseUnits, type Hex } from "viem";
import { AppHeader, TestnetBar } from "@/components/chrome";
import { GuardianList, HeirList, Lifecycle, Row, TransferTable, receiptUrl } from "@/components/PlanParts";
import { Pulse } from "@/components/Pulse";
import { Bracket, Button, ButtonLink, CanAct, Card, ExtLink, Field, Notice, StatusPill, TestnetTag, TransferPill, inputClass } from "@/components/ui";
import { CONTRACT_ID, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { ethBalance, getConfig, getVaultWithdrawal, tokenBalances, vaultAddress } from "@/lib/contract";
import { watch } from "@/lib/demo";
import { useAction, usePlan } from "@/lib/hooks";
import { actionsFor, assetLabel, describePlan, duration, failureText, formatAmount, formatEth, formatNear, formatToken, parseNear, relative, rolesOf, shortAddr, shortName, vaultSplit, type Role } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { Asset, ContractConfig, Erc20Token, PlanView, Transfer } from "@/lib/types";

type Tab = Role | "public";

export default function PlanPage() {
  return (
    <Suspense>
      <PlanScreen />
    </Suspense>
  );
}

function PlanScreen() {
  const owner = decodeURIComponent(useParams<{ owner: string }>().owner);
  const forced = useSearchParams().get("view");
  const { session } = useSession();
  const { view, error, refresh, chainNow } = usePlan(owner);
  const roles = useMemo(() => rolesOf(view ?? null, session?.accountId ?? null), [view, session]);
  const [tab, setTab] = useState<Tab | null>(null);
  const active: Tab = tab ?? (forced === "inspect" ? "public" : (roles[0] ?? "public"));

  useEffect(() => {
    if (view) watch(owner);
  }, [view, owner]);

  const heirMode = active === "heir";
  return (
    <div className={heirMode ? "min-h-dvh bg-paper" : "min-h-dvh"}>
      <TestnetBar compact={heirMode} />
      <AppHeader />
      <main className={heirMode ? "mx-auto flex max-w-[560px] flex-col gap-5 px-4 py-6" : "mx-auto flex max-w-[1360px] flex-col gap-5 px-4 py-8 sm:px-6"}>
        {view === undefined && !error && <p className="text-muted">Loading plan…</p>}
        {error && <Notice tone="error">Couldn't load the plan: {error}</Notice>}
        {view === null && (
          <Card className="flex flex-col gap-3">
            <h1 className="font-display text-3xl font-bold">No plan for {owner}</h1>
            <p className="text-muted">Check the account name, or create a plan if it's yours.</p>
            <div className="flex gap-2">
              <ButtonLink href="/inspect" variant="outline">
                Search again
              </ButtonLink>
              <ButtonLink href="/setup">Create a plan</ButtonLink>
            </div>
          </Card>
        )}
        {view && (
          <>
            {(roles.length > 0 || active === "public") && (
              <div role="tablist" aria-label="View as" className="flex flex-wrap gap-1.5">
                {[...roles, "public" as const].map((r) => (
                  <button
                    key={r}
                    role="tab"
                    aria-selected={active === r}
                    onClick={() => setTab(r)}
                    className={`min-h-11 rounded-full px-4 text-sm font-semibold ${active === r ? "bg-ink text-paper" : "border-[1.5px] border-ink"}`}
                  >
                    {r === "public" ? "Public inspector" : r === "owner" ? "As owner" : r === "guardian" ? "As guardian" : "As heir"}
                  </button>
                ))}
              </div>
            )}
            {active === "owner" && <OwnerView view={view} now={chainNow} refresh={refresh} />}
            {active === "guardian" && <GuardianView view={view} now={chainNow} refresh={refresh} />}
            {active === "heir" && <HeirView view={view} now={chainNow} refresh={refresh} />}
            {active === "public" && <PublicView view={view} now={chainNow} />}
          </>
        )}
      </main>
    </div>
  );
}

interface Props {
  view: PlanView;
  now: number;
  refresh?: () => Promise<void>;
}

interface Vault {
  address: Hex;
  balance: bigint | null;
  /** Allowlisted tokens with their vault balance (null while unread or on error). */
  tokens: { token: Erc20Token; balance: bigint | null }[];
  /** Most a single vault transaction can cost (gas limit × fee cap). */
  feePerTx: bigint | null;
}

function useVault(owner: string) {
  const [vault, setVault] = useState<Vault | null>(null);
  useEffect(() => {
    let off = false;
    (async () => {
      const [address, cfg] = await Promise.all([vaultAddress(owner).catch(() => null), getConfig().catch(() => null)]);
      if (!address || off) return;
      const list = cfg?.erc20_tokens ?? [];
      const feePerTx = cfg ? BigInt(cfg.eth_gas_limit) * BigInt(cfg.eth_max_fee_cap) : null;
      setVault({ address, balance: null, tokens: list.map((token) => ({ token, balance: null })), feePerTx });
      const [balance, toks] = await Promise.all([ethBalance(address).catch(() => null), tokenBalances(address, list)]);
      if (!off) setVault({ address, balance, tokens: list.map((token, i) => ({ token, balance: toks[i] ?? null })), feePerTx });
    })();
    return () => {
      off = true;
    };
  }, [owner]);
  return vault;
}

function Result({ result }: { result: ReturnType<typeof useAction>["result"] }) {
  if (!result) return null;
  return (
    <Notice tone={result.ok ? "ok" : "error"}>
      {result.text}{" "}
      {result.txHash && (
        <ExtLink href={`${NEAR_EXPLORER}/txns/${result.txHash}`} className="font-mono text-xs">
          View transaction
        </ExtLink>
      )}
    </Notice>
  );
}

// ------------------------------------------------------------------- owner

function OwnerView({ view, now, refresh }: Props) {
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const vault = useVault(view.plan.owner);
  const [amount, setAmount] = useState("0.1");
  const p = view.plan.policy;
  const s = view.status;
  const open = s === "Proposed" || s === "Waiting";
  const act = (label: string, method: string, args: Record<string, unknown>, deposit?: bigint) =>
    run(label, async () => {
      const r = await session!.call(method, args, { deposit });
      await refresh?.();
      return r;
    });

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <StatusPill status={s} />
          <h1 className="font-display text-[clamp(40px,6vw,64px)] font-bold leading-[0.92] tracking-[-0.045em]">Your plan</h1>
          <span className="font-mono text-xs text-muted">
            {view.plan.owner} · version {view.plan.version}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/plan/${view.plan.owner}?view=inspect`} variant="outline">
            Rules &amp; inspector
          </ButtonLink>
          {!open && s !== "Eligible" && s !== "Executing" && (
            <ButtonLink href="/setup?edit=1" variant="ink">
              Edit plan
            </ButtonLink>
          )}
        </div>
      </div>
      <Result result={result} />

      <div className="grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
        <Card dark className="flex flex-col items-center gap-4">
          <span className="self-start">
            <Bracket dark>Pulse</Bracket>
          </span>
          <Pulse overdueAt={view.overdue_at_ms} period={p.check_in_interval_ms + p.grace_ms} now={now} overdue={s !== "Active"} />
          <span className="font-mono text-xs text-muted-dark">
            last check-in {relative(view.plan.last_check_in_ms, now)} · {s === "Active" ? `unreachable ${relative(view.overdue_at_ms, now)}` : "now counted as unreachable"}
          </span>
          {(s === "Active" || s === "Overdue" || open) && (
            <Button variant="mint" className="w-full text-[17px]" disabled={!!busy} onClick={() => act(open ? "Check in (cancels the release)" : "Check in", "check_in", {})}>
              {busy === "Check in" ? "Checking in…" : open ? "I'm here — check in and cancel" : "Check in now"}
            </Button>
          )}
          {open && (
            <Button variant="outline-light" className="w-full" disabled={!!busy} onClick={() => act("Cancel release", "cancel_release", {})}>
              Cancel the release only
            </Button>
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <div className="flex justify-between gap-2">
            <Bracket>Lifecycle</Bracket>
            <span className="font-mono text-xs text-muted">{view.plan.proposal ? `proposal #${view.plan.proposal.id}` : "nothing pending"}</span>
          </div>
          <Lifecycle status={s} />
          <CanAct actions={actionsFor(view, "owner")} />
          <p className="border-t border-line pt-4 font-display text-xl leading-snug tracking-[-0.01em]">{describePlan(p)}</p>
          {open && view.plan.proposal?.waiting_ends_at_ms && (
            <Notice tone="info">
              You can cancel until <strong>{new Date(view.plan.proposal.waiting_ends_at_ms).toLocaleString()}</strong> ({relative(view.plan.proposal.waiting_ends_at_ms, now)}).
            </Notice>
          )}
        </Card>
      </div>

      <section aria-label="Assets" className="grid gap-3 md:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-mint px-2.5 py-1 font-mono text-xs font-bold">NEAR</span>
            <TestnetTag />
          </div>
          <span className="font-display text-[40px] font-bold leading-none tracking-[-0.04em]">{formatNear(view.plan.escrow)}</span>
          <span className="font-mono text-xs text-muted">held by {CONTRACT_ID} for this plan</span>
          {!open && (
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="Amount (NEAR)">
                <input className={`${inputClass} w-32`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Button disabled={!!busy} onClick={() => act("Add NEAR", "deposit", { owner: view.plan.owner }, parseNear(amount))}>
                Add
              </Button>
              <Button variant="outline" disabled={!!busy} onClick={() => act("Withdraw NEAR", "withdraw", { amount: parseNear(amount).toString() })}>
                Withdraw
              </Button>
            </div>
          )}
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-s-approved px-2.5 py-1 font-mono text-xs font-bold">ETH · Sepolia</span>
            <TestnetTag />
          </div>
          <span className="font-display text-[40px] font-bold leading-none tracking-[-0.04em]">{vault?.balance != null ? formatEth(vault.balance) : "…"}</span>
          {vault && (
            <span className="break-all font-mono text-xs text-muted">
              vault <ExtLink href={`${ETH_EXPLORER}/address/${vault.address}`}>{vault.address}</ExtLink>
            </span>
          )}
          {vault?.tokens.map(({ token, balance }) => (
            <span key={token.address} className="font-mono text-sm">
              {balance != null ? formatToken(balance, token) : "…"} {token.symbol}
            </span>
          ))}
          <span className="text-sm text-muted">Send Sepolia ETH or an allowed token to this address to include it. It's controlled only by this plan through Chain Signatures.</span>
          {vault && <VaultWithdraw owner={view.plan.owner} vault={vault} locked={!!view.plan.proposal && s !== "Settled"} act={act} busy={!!busy} />}
        </Card>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <HeirList view={view} />
        <GuardianList view={view} />
      </div>
      {view.plan.proposal && (
        <Card className="flex flex-col gap-3">
          <Bracket>Proposed transfers</Bracket>
          <TransferTable transfers={view.plan.proposal.transfers} />
        </Card>
      )}
    </>
  );
}

/**
 * D7: the owner takes ETH or a token back out of the vault. One withdrawal at a
 * time, only with no open release; network fees come from the vault's ETH.
 */
function VaultWithdraw({ owner, vault, locked, act, busy }: { owner: string; vault: Vault; locked: boolean; act: (label: string, method: string, args: Record<string, unknown>) => Promise<unknown>; busy: boolean }) {
  const { session } = useSession();
  const [w, setW] = useState<Transfer | null | undefined>(undefined);
  const [asset, setAsset] = useState("Eth");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(session?.accountId.startsWith("0x") ? session.accountId : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    const load = () => getVaultWithdrawal(owner).then((x) => !off && setW(x)).catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      off = true;
      clearInterval(t);
    };
  }, [owner]);

  const token = vault.tokens.find((t) => t.token.address === asset)?.token;
  const pending = w && w.state !== "Confirmed" && !(w.state === "Failed" && w.failure === "Reverted");
  const maxEth = vault.balance != null && vault.feePerTx != null && vault.balance > vault.feePerTx ? vault.balance - vault.feePerTx : 0n;

  function submit() {
    setError(null);
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) throw new Error("Enter a Sepolia address (0x + 40 hex characters).");
      const units = parseUnits(amount.trim() || "0", token ? token.decimals : 18);
      if (units <= 0n) throw new Error("Enter an amount above zero.");
      if (!token && units > maxEth) throw new Error(`At most ${formatEth(maxEth)} ETH: one transfer's network fee stays in the vault.`);
      const a: Asset = token ? { Erc20: token.address } : "Eth";
      void act("Withdraw from vault", "withdraw_vault", { asset: a, amount: units.toString(), to: to.trim().toLowerCase() });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="font-semibold">Withdraw from the vault</span>
      {w && (
        <span className="text-sm">
          Last withdrawal: {w.amount === "0" ? "cancelled (nonce freed)" : formatAmount(w)} to <span className="font-mono">{shortAddr(w.destination)}</span> · {w.state}
          {w.failure ? ` (${w.failure})` : ""}
          {w.tx_hash && (
            <>
              {" · "}
              <ExtLink href={`${ETH_EXPLORER}/tx/${w.tx_hash}`}>receipt</ExtLink>
            </>
          )}
        </span>
      )}
      {locked ? (
        <span className="text-sm text-muted">Locked while a release is open, so heirs' amounts can't change.</span>
      ) : pending ? (
        <span className="text-sm text-muted">Finishing your last withdrawal first. Guardians can't propose a release until it's done.</span>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Asset">
            <select className={`${inputClass} w-28`} value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="Eth">ETH</option>
              {vault.tokens.map(({ token: t }) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input className={`${inputClass} w-32`} inputMode="decimal" value={amount} placeholder={token ? "0.0" : formatEth(maxEth)} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="To (Sepolia address)">
            <input className={`${inputClass} w-[22rem] max-w-full font-mono text-xs`} value={to} placeholder="0x…" onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button variant="outline" disabled={busy} onClick={submit}>
            Withdraw
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

// ---------------------------------------------------------------- guardian

function GuardianView({ view, now, refresh }: Props) {
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const vault = useVault(view.plan.owner);
  const [cfg, setCfg] = useState<ContractConfig | null>(null);
  useEffect(() => void getConfig().then(setCfg).catch(() => {}), []);
  const me = session!.accountId;
  const name = shortName(view.plan.owner);
  const s = view.status;
  const p = view.plan.proposal;
  const ethHeirs = view.plan.policy.heirs.filter((h) => h.eth_destination).length;
  const heldTokens = (vault?.tokens ?? []).filter((t) => t.balance != null && t.balance > 0n);
  const split =
    cfg && vault?.balance != null
      ? vaultSplit({ ethHeirs, ethBalance: vault.balance, tokenBalances: heldTokens.map((t) => t.balance!), gasLimit: cfg.eth_gas_limit, feeCap: BigInt(cfg.eth_max_fee_cap) })
      : null;
  const act = (label: string, method: string, args: Record<string, unknown>) =>
    run(label, async () => {
      const r = await session!.call(method, args, { tgas: 100 });
      await refresh?.();
      return r;
    });

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <StatusPill status={s} />
        <h1 className="font-display text-[clamp(36px,5vw,56px)] font-bold leading-[0.95] tracking-[-0.04em]">You guard {name}'s plan.</h1>
        <p className="max-w-[760px] text-lg leading-relaxed">{describePlan(view.plan.policy, name)}</p>
      </div>
      <Result result={result} />
      <CanAct actions={actionsFor(view, "guardian", me)} />

      {s === "Active" && (
        <Card className="flex flex-col gap-2">
          <Bracket>Nothing to do</Bracket>
          <p>
            {name} is checking in. If they stop, you'll be able to propose a release {relative(view.overdue_at_ms, now)}.
          </p>
        </Card>
      )}

      {s === "Overdue" && (
        <Card className="flex flex-col gap-4">
          <Bracket>Propose a release</Bracket>
          <p>
            {name} hasn't checked in since {new Date(view.plan.last_check_in_ms).toLocaleString()}. Proposing freezes the plan and asks the other guardians to approve. {name} can still cancel until the waiting period ends.
          </p>
          <div className="grid gap-1">
            <Row k="NEAR to distribute" v={`${formatNear(view.plan.escrow)} NEAR`} />
            {ethHeirs > 0 && (
              <>
                <Row k="ETH in vault" v={vault?.balance != null ? `${formatEth(vault.balance)} ETH` : "reading…"} />
                {heldTokens.map(({ token, balance }) => (
                  <Row key={token.address} k={`${token.symbol} to distribute`} v={`${formatToken(balance!, token)} ${token.symbol}`} />
                ))}
                <Row k="Network-fee reserve" v={split ? `${formatEth(split.reserve)} ETH (${split.transfers} transfer${split.transfers === 1 ? "" : "s"})` : "…"} />
                <Row k="ETH to distribute" v={split ? `${formatEth(split.ethToSplit)} ETH` : "…"} />
                {split?.error && <Notice tone="error">The vault doesn't hold enough ETH to pay the network fees for these transfers. Add ETH to the vault first.</Notice>}
              </>
            )}
          </div>
          <Button
            className="self-start"
            disabled={!!busy || (ethHeirs > 0 && (vault?.balance == null || vault.tokens.some((t) => t.balance == null) || !!split?.error))}
            onClick={() =>
              act("Propose release", "propose_release", {
                owner: view.plan.owner,
                eth_balance: ethHeirs > 0 && vault?.balance ? vault.balance.toString() : null,
                erc20_balances: ethHeirs > 0 && heldTokens.length ? heldTokens.map((t) => ({ token: t.token.address, amount: t.balance!.toString() })) : null,
              })
            }
          >
            {busy ? "Proposing…" : "Propose release"}
          </Button>
        </Card>
      )}

      {p && (
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap justify-between gap-2">
            <Bracket>Proposal #{p.id}</Bracket>
            <span className="font-mono text-xs text-muted">
              by {shortName(p.proposer)} · {p.approvals.length} of {view.plan.policy.quorum} approvals
            </span>
          </div>
          <TransferTable transfers={p.transfers} />
          {s === "Proposed" && !p.approvals.includes(me) && !p.rejections.includes(me) && (
            <div className="flex flex-wrap gap-2">
              <Button variant="mint" disabled={!!busy} onClick={() => act("Approve", "approve_release", { owner: view.plan.owner, proposal_id: p.id })}>
                Approve this exact proposal
              </Button>
              <Button variant="outline" disabled={!!busy} onClick={() => act("Reject", "reject_release", { owner: view.plan.owner, proposal_id: p.id })}>
                Reject
              </Button>
            </div>
          )}
          {s === "Waiting" && p.waiting_ends_at_ms && (
            <Notice>
              Approved. {name} can cancel until {new Date(p.waiting_ends_at_ms).toLocaleString()} ({relative(p.waiting_ends_at_ms, now)}). Then the heirs can receive.
            </Notice>
          )}
        </Card>
      )}
      <GuardianList view={view} />
    </>
  );
}

// -------------------------------------------------------------------- heir
// Paper theme, plain words; hashes only under "Technical details".

function HeirView({ view, now, refresh }: Props) {
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const me = session!.accountId;
  const first = shortName(me);
  const owner = shortName(view.plan.owner);
  const s = view.status;
  const p = view.plan.proposal;
  const heir = view.plan.policy.heirs.find((h) => h.account_id === me);
  const mine = p?.transfers.map((t, index) => ({ t, index })).filter(({ t }) => t.heir === me) ?? [];
  const started = mine.some(({ t }) => t.state !== "Pending");
  const ready = p?.waiting_ends_at_ms;

  const claim = () =>
    run(
      "Receive",
      async () => {
        const r = await session!.call("claim", { owner: view.plan.owner }, { tgas: 300 });
        await refresh?.();
        return r;
      },
      "On its way. This page updates as each transfer lands.",
    );
  const retry = (index: number) =>
    run("Retry", async () => {
      const r = await session!.call("retry_transfer", { owner: view.plan.owner, index }, { tgas: 300 });
      await refresh?.();
      return r;
    });

  let title = `Nothing for you to do yet, ${first}.`;
  let body = `${owner} has set something aside for you. If ${owner} stops checking in, their guardians can start a release and we'll walk you through receiving it.`;
  if (s === "Proposed") body = `${owner}'s guardians have proposed a release. Nothing moves until enough of them approve and a waiting period passes.`;
  if (s === "Waiting" && ready) body = `In about ${relative(ready, now).replace("in ", "")} you'll be able to receive what ${owner} set aside for you. If ${owner} turns out to be reachable, they can stop this until then. That's by design.`;
  if (s === "Eligible" || (s === "Executing" && !started)) {
    title = `It's ready for you, ${first}.`;
    body = `You can now receive what ${owner} set aside for you. It goes straight to the addresses ${owner} chose; network fees are already covered.`;
  }
  if (s === "Executing" && started) {
    title = "On its way.";
    body = "Each part arrives separately. You can close this page; nothing is lost if you do.";
  }
  if (s === "Settled") {
    title = "Done.";
    body = `Everything ${owner} set aside for you has arrived. Your receipts are below.`;
  }

  return (
    <>
      <StatusPill status={s} plain />
      <h1 className="font-display text-[44px] font-bold leading-[0.95] tracking-[-0.04em]">{title}</h1>
      <p className="text-lg leading-relaxed">{body}</p>
      <Result result={result} />

      <section className="flex flex-col gap-2 rounded-card border-[1.5px] border-ink bg-card p-5">
        <span className="text-sm text-muted">Set aside for you</span>
        <span className="font-display text-[32px] font-bold leading-none tracking-[-0.03em]">{heir ? `${(heir.share_bps / 100).toFixed(heir.share_bps % 100 ? 2 : 0)}% of ${owner}'s plan` : "—"}</span>
        <span className="text-base leading-normal">
          {mine.length ? mine.map(({ t }) => formatAmount(t)).join(" and ") : "Amounts are fixed when a release is proposed."}
          {heir?.eth_destination && <> · Ethereum wallet ending in <strong>{heir.eth_destination.slice(-4).toUpperCase()}</strong></>}
          {heir?.near_destination && <> · NEAR account <strong>{heir.near_destination.split(".")[0]}</strong></>}
        </span>
      </section>

      {s === "Waiting" && ready && (
        <div className="flex items-center justify-between rounded-card bg-mint px-5 py-4">
          <span className="font-semibold">Ready from</span>
          <span className="font-display text-2xl font-bold">{new Date(ready).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}

      {(s === "Eligible" || s === "Executing") && mine.some(({ t }) => t.state === "Pending") && (
        <Button variant="mint" className="min-h-14 w-full text-lg" disabled={!!busy} onClick={claim}>
          {busy ? "Starting…" : "Receive my share"}
        </Button>
      )}

      {started && (
        <section className="flex flex-col gap-3" aria-label="Your transfers">
          {mine.map(({ t, index }) => {
            const url = receiptUrl(t);
            return (
              <div key={index} className="flex flex-col gap-2 rounded-card border-[1.5px] border-ink bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xl font-bold">{formatAmount(t)}</span>
                  <TransferPill state={t.state} plain />
                </div>
                {t.state === "Failed" && (
                  <>
                    <p className="text-sm">{failureText(t)}</p>
                    {!["GasLimitTooLow", "Reverted"].includes(t.failure ?? "") && (
                      <Button variant="outline" disabled={!!busy} onClick={() => retry(index)}>
                        Try again
                      </Button>
                    )}
                  </>
                )}
                {url && (
                  <ExtLink href={url} className="text-sm font-semibold">
                    View receipt
                  </ExtLink>
                )}
              </div>
            );
          })}
        </section>
      )}

      <details className="rounded-card border-[1.5px] border-line p-4">
        <summary className="min-h-11 cursor-pointer content-center font-semibold">Technical details</summary>
        <div className="flex flex-col gap-1 pt-2">
          <Row k="Plan" v={view.plan.owner} mono />
          <Row k="Contract" v={CONTRACT_ID} mono />
          {mine.map(({ t, index }) => (
            <Row key={index} k={`${assetLabel(t.asset)} transfer #${index}`} v={`${t.destination}${t.tx_hash ? ` · ${t.tx_hash}` : ""}${t.eth_tx ? ` · nonce ${t.eth_tx.nonce}` : ""}`} mono />
          ))}
        </div>
      </details>
      <Link href="/#how" className="flex min-h-14 items-center justify-center rounded-full border-[1.5px] border-ink font-semibold">
        What happens next?
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ public

function PublicView({ view, now }: Props) {
  const vault = useVault(view.plan.owner);
  const p = view.plan.policy;
  const prop = view.plan.proposal;
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <StatusPill status={view.status} />
        <h1 className="font-display text-[clamp(36px,5vw,56px)] font-bold leading-[0.95] tracking-[-0.04em]">Plan inspector</h1>
        <span className="break-all font-mono text-sm text-muted">{view.plan.owner}</span>
      </div>
      <CanAct actions={actionsFor(view, "public")} />
      <Card className="flex flex-col gap-3">
        <Bracket>In plain words</Bracket>
        <p className="font-display text-xl leading-snug tracking-[-0.01em]">{describePlan(p, shortName(view.plan.owner))}</p>
        <Lifecycle status={view.status} />
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col">
          <Bracket>Rules as stored on-chain</Bracket>
          <div className="mt-3">
            <Row k="Check-in interval" v={duration(p.check_in_interval_ms)} />
            <Row k="Grace period" v={duration(p.grace_ms)} />
            <Row k="Waiting period" v={duration(p.waiting_period_ms)} />
            <Row k="Quorum" v={`${p.quorum} of ${p.guardians.length} guardians`} />
            <Row k="Last check-in" v={`${new Date(view.plan.last_check_in_ms).toLocaleString()} (${relative(view.plan.last_check_in_ms, now)})`} />
            <Row k="Unreachable from" v={`${new Date(view.overdue_at_ms).toLocaleString()} (${relative(view.overdue_at_ms, now)})`} />
            <Row k="Plan version" v={view.plan.version} />
            <Row k="NEAR escrow" v={`${formatNear(view.plan.escrow)} NEAR`} />
            <Row k="ETH vault" v={vault ? <ExtLink href={`${ETH_EXPLORER}/address/${vault.address}`}>{vault.address}</ExtLink> : "…"} mono />
            <Row k="Vault balance" v={vault?.balance != null ? `${formatEth(vault.balance)} ETH` : "…"} />
            {vault?.tokens.map(({ token, balance }) => (
              <Row key={token.address} k={`Vault ${token.symbol}`} v={balance != null ? `${formatToken(balance, token)} ${token.symbol}` : "…"} />
            ))}
            <Row k="Vault next nonce" v={view.plan.eth_next_nonce} />
            <Row k="Contract" v={<ExtLink href={`${NEAR_EXPLORER}/address/${CONTRACT_ID}`}>{CONTRACT_ID}</ExtLink>} mono />
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          <HeirList view={view} />
          <GuardianList view={view} />
        </div>
      </div>
      {prop && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap justify-between gap-2">
            <Bracket>Proposal #{prop.id}</Bracket>
            <span className="font-mono text-xs text-muted">
              NEAR snapshot {formatNear(prop.near_snapshot)} · ETH snapshot {formatEth(prop.eth_snapshot)} · fee reserve {formatEth(prop.eth_fee_reserve)} · gas {prop.eth_gas_limit.toLocaleString()}
            </span>
          </div>
          <TransferTable transfers={prop.transfers} technical />
        </Card>
      )}
      <details className="rounded-card border-[1.5px] border-line p-4">
        <summary className="min-h-11 cursor-pointer content-center font-semibold">Raw contract view (JSON)</summary>
        <pre className="mt-2 max-h-[480px] overflow-auto rounded-tile bg-void p-4 font-mono text-xs text-paper">{JSON.stringify(view, null, 2)}</pre>
      </details>
      <span className="text-xs text-muted">Addresses shown in full or as {shortAddr("0x0000000000000000000000000000000000000000")} for brevity. Everything here is read directly from the chain.</span>
    </>
  );
}
