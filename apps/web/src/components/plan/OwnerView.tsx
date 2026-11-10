"use client";
// The owner's view: check in (or stop an open release), see the timeline,
// manage what's in the plan, and tune rules and release options.
import { ArrowDownToLine, ArrowUpFromLine, Ban, Coins, HeartPulse, Pencil, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { CONTRACT_ID, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { getConfig, getVaultWithdrawal } from "@/lib/contract";
import { useEthQuote, useConfig } from "@/lib/fees";
import { nextStep } from "@/lib/guide";
import { describePlan, duration, formatAmount, formatEth, formatNear, formatToken, parseNear, shortAddr } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { Asset, ContractConfig, PlanView, Transfer } from "@/lib/types";
import { useVault, type Vault } from "@/lib/vault";
import { BtcOwnerCard, useBtc } from "../Bitcoin";
import { useConfirm } from "../feedback";
import { Address, Dialog, Field, Term } from "../interactive";
import { GuardianList, HeirList, Timeline, receiptUrl } from "../PlanParts";
import { Pulse } from "../Pulse";
import { OptionsCard } from "../ReleaseOptions";
import { RulesCard } from "../ReleaseRules";
import { HistoryCard } from "../Rounds";
import { useTx, type Act } from "../tx";
import { AssetHead, Button, ButtonLink, Card, ExtLink, Notice, SectionTitle, Skeleton, TestnetTag, TransferPill, inputClass } from "../ui";
import { Group, NowCard, ProposalPanel, type PlanCtx } from "./common";

export function OwnerView({ ctx }: { ctx: PlanCtx }) {
  const { view, now, refresh, rules, history, options, me } = ctx;
  const confirm = useConfirm();
  const { busy, act } = useTx(refresh);
  const vault = useVault(view.plan.owner);
  const btc = useBtc(view.plan.owner);
  const p = view.plan.policy;
  const s = view.status;
  const open = s === "Proposed" || s === "Waiting";
  const locked = !!view.plan.proposal && s !== "Settled";
  const step = nextStep(view, "owner", { now, me });
  const checkingIn = busy?.startsWith("Check in");

  const checkIn = () => act(open ? "Check in (cancels the release)" : "Check in", "check_in", {}, { done: open ? "You're here. The release is cancelled and the clock has restarted." : "Checked in. The clock has restarted." });
  const cancelOnly = async () => {
    if (
      await confirm({
        title: "Cancel the release only?",
        body: "The release stops, but you stay unreachable until you check in, so guardians could propose again. Checking in is usually what you want.",
        confirmLabel: "Cancel the release",
        tone: "ink",
      })
    )
      await act("Cancel release", "cancel_release", {}, { done: "Release cancelled." });
  };

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <NowCard step={step} now={now} role="owner">
          {(s === "Active" || s === "Overdue" || open) && (
            <Button variant="primary" size="lg" icon={HeartPulse} loading={checkingIn} disabled={!!busy && !checkingIn} onClick={checkIn} className="sm:min-w-[220px]">
              {open ? "I'm here, check in and cancel" : "Check in now"}
            </Button>
          )}
          {s === "Settled" && (
            <Button variant="primary" size="lg" icon={HeartPulse} loading={checkingIn} onClick={checkIn}>
              Check in to take the plan back
            </Button>
          )}
          {open && (
            <Button variant="outline" size="lg" icon={Ban} disabled={!!busy} onClick={cancelOnly}>
              Cancel the release only
            </Button>
          )}
          {!open && s !== "Eligible" && s !== "Executing" && (
            <ButtonLink href="/setup?edit=1" variant="subtle" size="lg" icon={Pencil}>
              Edit plan
            </ButtonLink>
          )}
        </NowCard>
        <Card dark className="flex flex-col items-center justify-center gap-4 dark-panel">
          <span className="self-start text-sm font-semibold text-muted-dark">
            <Term k="checkIn">Check-in pulse</Term>
          </span>
          <div className="w-[min(220px,70vw)]">
            <Pulse overdueAt={view.overdue_at_ms} period={p.check_in_interval_ms + p.grace_ms} now={now} overdue={s !== "Active"} released={s === "Eligible" || s === "Executing" ? "releasing" : s === "Settled" ? "settled" : undefined} />
          </div>
          <span className="text-center text-xs text-muted-dark">Every {duration(p.check_in_interval_ms)} · gas paid by Behest</span>
        </Card>
      </div>

      <Card className="flex flex-col gap-5">
        <SectionTitle icon={ScrollText} title="How your plan works" sub="Read it the way your guardians and heirs will." />
        <p className="text-lg leading-snug tracking-[-0.01em]">{describePlan(p)}</p>
        <Timeline view={view} now={now} />
      </Card>

      <Group title="What's in the plan">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <NearCard view={view} open={open} busy={!!busy} act={act} />
          <EthCard view={view} vault={vault} locked={locked} busy={!!busy} act={act} />
          <BtcOwnerCard view={view} btc={btc} locked={locked} />
        </div>
      </Group>

      {view.plan.proposal && <ProposalPanel view={view} now={now} me={me} />}

      <Group title="People">
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <HeirList view={view} />
          <GuardianList view={view} />
        </div>
      </Group>

      <Group title="Advanced">
        <RulesCard view={view} now={now} rules={rules.rules} editable={!view.plan.proposal || s === "Settled"} act={act} busy={!!busy} signedIn onChanged={rules.reload} />
        <OptionsCard view={view} now={now} me={me} editable={!view.plan.proposal || s === "Settled"} act={act} busy={!!busy} state={options} />
        <HistoryCard view={view} history={history} />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- NEAR card

const PRESETS = ["0.1", "0.5", "1"];

function AmountField({ value, onChange, unit, max }: { value: string; onChange: (v: string) => void; unit: string; max?: string }) {
  return (
    <Field label={`Amount (${unit})`}>
      {(p) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-center rounded-row bg-subtle px-4 focus-within:ring-2 focus-within:ring-signal/40">
            <input {...p} className="min-h-16 min-w-0 flex-1 bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none" inputMode="decimal" value={value} placeholder="0" onChange={(e) => onChange(e.target.value)} autoFocus />
            <span className="text-xl font-medium text-muted">{unit}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((x) => (
              <button key={x} type="button" onClick={() => onChange(x)} className="min-h-9 rounded-full border border-line px-3 text-sm hover:bg-subtle">
                {x}
              </button>
            ))}
            {max && (
              <button type="button" onClick={() => onChange(max)} className="min-h-9 rounded-full border border-line px-3 text-sm hover:bg-subtle">
                Max
              </button>
            )}
          </div>
        </div>
      )}
    </Field>
  );
}

function NearCard({ view, open, busy, act }: { view: PlanView; open: boolean; busy: boolean; act: Act }) {
  const [dlg, setDlg] = useState<"add" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("0.1");
  let units: bigint | null = null;
  try {
    units = parseNear(amount || "0");
  } catch {}
  const escrow = BigInt(view.plan.escrow);
  const err = units == null ? "Not a NEAR amount." : units <= 0n ? "Enter more than 0." : dlg === "withdraw" && units > escrow ? `The plan holds ${formatNear(escrow)} NEAR.` : null;
  const submit = async () => {
    if (err || units == null) return;
    const ok =
      dlg === "add"
        ? await act("Add NEAR", "deposit", { owner: view.plan.owner }, { deposit: units, done: `Added ${amount} NEAR to the plan.` })
        : await act("Withdraw NEAR", "withdraw", { amount: units.toString() }, { done: `Withdrew ${amount} NEAR.` });
    if (ok) setDlg(null);
  };
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <AssetHead ticker="NEAR" name="NEAR" sub={<Term k="escrow">in plan escrow</Term>} />
        <TestnetTag />
      </div>
      <span className="tabular text-[40px] font-medium leading-none tracking-[-0.04em]">{formatNear(view.plan.escrow)}</span>
      <span className="flex items-center gap-1 text-xs text-muted">
        held by <Address value={CONTRACT_ID} href={`${NEAR_EXPLORER}/address/${CONTRACT_ID}`} label="contract" />
      </span>
      {!open ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ink" icon={ArrowDownToLine} disabled={busy} onClick={() => setDlg("add")}>
            Add
          </Button>
          <Button size="sm" variant="outline" icon={ArrowUpFromLine} disabled={busy || escrow === 0n} onClick={() => setDlg("withdraw")}>
            Withdraw
          </Button>
        </div>
      ) : (
        <span className="text-[13px] text-muted">Locked while a release is open.</span>
      )}
      <NearTokens view={view} open={open} busy={busy} act={act} />
      <Dialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg === "add" ? "Add NEAR to the plan" : "Withdraw NEAR"}
        description={dlg === "add" ? "It's held by the contract for this plan and split between heirs on release." : `The plan holds ${formatNear(escrow)} NEAR. It goes back to your account.`}
        size="sm"
        footer={
          <Button variant="primary" loading={busy} disabled={!!err} onClick={submit} className="w-full sm:w-auto">
            {dlg === "add" ? `Add ${amount || 0} NEAR` : `Withdraw ${amount || 0} NEAR`}
          </Button>
        }
      >
        <AmountField value={amount} onChange={setAmount} unit="NEAR" max={dlg === "withdraw" ? formatNear(escrow, 24) : undefined} />
        {amount && err && <span className="text-[13px] font-semibold text-error">{err}</span>}
      </Dialog>
    </Card>
  );
}

/**
 * NEP-141 tokens held for the plan. Adding wNEAR wraps NEAR first (the token
 * registers the owner and keeps its registration fee), then sends it here with
 * ft_transfer_call; the token refunds anything Behest doesn't accept.
 */
function NearTokens({ view, open, busy, act }: { view: PlanView; open: boolean; busy: boolean; act: Act }) {
  const [cfg, setCfg] = useState<ContractConfig | null>(null);
  const [amt, setAmt] = useState("0.1");
  const [which, setWhich] = useState<string | null>(null);
  useEffect(() => void getConfig().then(setCfg).catch(() => setCfg(null)), []);
  const fts = cfg?.nep141_tokens ?? [];
  if (fts.length === 0) return null;
  const held = (id: string) => BigInt(view.ft_escrow?.find((b) => b.token === id)?.amount ?? "0");
  const t = fts.find((x) => x.account_id === which);
  const units = (() => {
    try {
      return t ? parseUnits(amt, t.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        <Coins aria-hidden className="size-4 text-muted" />
        NEAR tokens
      </span>
      <ul className="flex flex-col gap-1">
        {fts.map((x) => (
          <li key={x.account_id} className="flex min-h-11 items-center justify-between gap-2">
            <span className="flex min-w-0 flex-col">
              <span className="tabular text-sm font-medium">
                {formatToken(held(x.account_id), x)} {x.symbol}
              </span>
              <span className="truncate font-mono text-xs text-muted">{x.account_id}</span>
            </span>
            {!open && (
              <Button size="sm" variant="subtle" disabled={busy} onClick={() => setWhich(x.account_id)}>
                Manage
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!open && <span className="text-xs leading-relaxed text-muted">Tokens split between heirs with a NEAR account. Each heir&apos;s first token payment includes a small registration fee, taken from the plan&apos;s NEAR.</span>}
      <Dialog open={!!t} onClose={() => setWhich(null)} title={t ? `${t.symbol} in the plan` : ""} description={t ? `The plan holds ${formatToken(held(t.account_id), t)} ${t.symbol}.` : undefined} size="sm">
        {t && (
          <>
            <AmountField value={amt} onChange={setAmt} unit={t.symbol} />
            <div className="flex flex-wrap gap-2">
              {t.account_id.startsWith("wrap.") && (
                <Button variant="outline" disabled={busy || units === 0n} onClick={() => act(`Wrap ${amt} NEAR`, "near_deposit", {}, { deposit: units, receiverId: t.account_id })}>
                  Wrap NEAR first
                </Button>
              )}
              <Button
                variant="primary"
                icon={ArrowDownToLine}
                loading={busy}
                disabled={units === 0n}
                onClick={() => act(`Add ${t.symbol}`, "ft_transfer_call", { receiver_id: CONTRACT_ID, amount: units.toString(), msg: view.plan.owner }, { deposit: 1n, receiverId: t.account_id }).then((ok) => ok && setWhich(null))}
              >
                Add {t.symbol}
              </Button>
              <Button variant="outline" icon={ArrowUpFromLine} disabled={busy || units === 0n || units > held(t.account_id)} onClick={() => act(`Withdraw ${t.symbol}`, "withdraw_ft", { token: t.account_id, amount: units.toString() }).then((ok) => ok && setWhich(null))}>
                Withdraw
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- ETH card

function EthCard({ view, vault, locked, busy, act }: { view: PlanView; vault: Vault | null; locked: boolean; busy: boolean; act: Act }) {
  const [w, setW] = useState<Transfer | null | undefined>(undefined);
  const [dlg, setDlg] = useState(false);
  const owner = view.plan.owner;
  useEffect(() => {
    let off = false;
    const load = () => getVaultWithdrawal(owner).then((x) => !off && setW(x)).catch(() => {});
    void load();
    // Only an open withdrawal changes; otherwise check rarely.
    const t = setInterval(() => !document.hidden && void load(), 15_000);
    return () => {
      off = true;
      clearInterval(t);
    };
  }, [owner]);
  const pending = w && w.state !== "Confirmed" && !(w.state === "Failed" && (w.failure === "Reverted" || w.failure === "Cancelled"));
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <AssetHead ticker="ETH" name="Ethereum" sub="Sepolia" />
        <TestnetTag />
      </div>
      <div className="flex flex-col gap-1">
        <span className="tabular text-[40px] font-medium leading-none tracking-[-0.04em]">{vault?.balance != null ? formatEth(vault.balance) : <Skeleton className="h-10 w-28" />}</span>
        <span className="text-sm text-muted">
          ETH in the <Term k="vault">vault</Term>
        </span>
      </div>
      {vault ? <Address value={vault.address} href={`${ETH_EXPLORER}/address/${vault.address}`} className="text-muted" label="Ethereum vault address" /> : <Skeleton className="h-4 w-40" />}
      {vault && vault.tokens.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line pt-3">
          {vault.tokens.map(({ token, balance }) => (
            <li key={token.address} className="flex items-center justify-between text-sm">
              <span className="text-muted">{token.symbol}</span>
              <span className="tabular font-medium">{balance != null ? formatToken(balance, token) : "…"}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="text-[13px] leading-relaxed text-muted">Send Sepolia ETH or an allowed token to this address to include it. Only this plan can sign for it, through Chain Signatures.</span>
      {w && (
        <div className="flex flex-col gap-1.5 rounded-row bg-subtle p-3 text-sm">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">Last withdrawal</span>
            <TransferPill state={w.state} />
          </span>
          <span className="text-muted">
            {w.amount === "0" ? "Cancelled (nonce freed)" : formatAmount(w)} to <span className="font-mono">{shortAddr(w.destination)}</span>
            {w.failure ? ` · ${w.failure}` : ""}
          </span>
          {w.tx_hash && <ExtLink href={receiptUrl(w) ?? `${ETH_EXPLORER}/tx/${w.tx_hash}`}>View receipt</ExtLink>}
        </div>
      )}
      {locked ? (
        <span className="text-[13px] text-muted">Locked while a release is open, so heirs&apos; amounts can&apos;t change.</span>
      ) : pending ? (
        <span className="text-[13px] text-muted">Finishing your last withdrawal first. Guardians can&apos;t propose a release until it&apos;s done.</span>
      ) : (
        vault && (
          <Button size="sm" variant="outline" icon={ArrowUpFromLine} className="self-start" disabled={busy} onClick={() => setDlg(true)}>
            Withdraw from vault
          </Button>
        )
      )}
      <Dialog open={dlg} onClose={() => setDlg(false)} title="Withdraw from the vault" description="One withdrawal at a time, only with no open release. The network fee comes from the vault's ETH.">
        {dlg && vault && <VaultWithdraw vault={vault} busy={busy} onSubmit={(args) => act("Withdraw from vault", "withdraw_vault", args, { done: "Withdrawal signed. It reaches Sepolia shortly." }).then((ok) => ok && setDlg(false))} />}
      </Dialog>
    </Card>
  );
}

/** D7: the owner takes ETH or a token back out of the vault. */
function VaultWithdraw({ vault, busy, onSubmit }: { vault: Vault; busy: boolean; onSubmit: (args: Record<string, unknown>) => void }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const [asset, setAsset] = useState("Eth");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(session?.accountId.startsWith("0x") ? session.accountId : "");
  const [error, setError] = useState<string | null>(null);
  const token = vault.tokens.find((t) => t.token.address === asset)?.token;
  const maxEth = vault.balance != null && vault.feePerTx != null && vault.balance > vault.feePerTx ? vault.balance - vault.feePerTx : 0n;
  const cfg = useConfig();
  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to.trim()) ? (to.trim() as `0x${string}`) : null;
  const quote = useEthQuote(cfg, vault.address, validTo ? [{ to: validTo, token: token?.address as `0x${string}` | undefined }] : []);

  async function submit() {
    setError(null);
    try {
      if (!validTo) throw new Error("Enter a Sepolia address (0x + 40 hex characters).");
      const units = parseUnits(amount.trim() || "0", token ? token.decimals : 18);
      if (units <= 0n) throw new Error("Enter an amount above zero.");
      if (!token && units > maxEth) throw new Error(`At most ${formatEth(maxEth)} ETH: one transfer's network fee stays in the vault.`);
      const a: Asset = token ? { Erc20: token.address } : "Eth";
      const ok = await confirm({
        title: `Send ${amount.trim()} ${token ? token.symbol : "ETH"}?`,
        body: "Ethereum transfers can't be reversed. Check the address.",
        rows: [
          ["To", <span key="to" className="break-all font-mono text-xs">{validTo}</span>],
          ["Network fee", quote ? `≈ ${formatEth(quote.total)} ETH, from the vault` : "from the vault"],
        ],
        confirmLabel: "Withdraw",
      });
      if (ok) onSubmit({ asset: a, amount: units.toString(), to: to.trim().toLowerCase() });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-2">
        <Field label="Asset">
          {(p) => (
            <select {...p} className={inputClass} value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="Eth">ETH</option>
              {vault.tokens.map(({ token: t }) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Amount">
          {(p) => (
            <div className="flex gap-2">
              <input {...p} className={inputClass} inputMode="decimal" value={amount} placeholder={token ? "0.0" : formatEth(maxEth)} onChange={(e) => setAmount(e.target.value)} />
              {!token && (
                <Button variant="subtle" size="sm" className="min-h-12" onClick={() => setAmount(formatEth(maxEth, 18))}>
                  Max
                </Button>
              )}
            </div>
          )}
        </Field>
      </div>
      <Field label="To (Sepolia address)" error={to.trim() && !validTo ? "0x followed by 40 characters." : null}>
        {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} value={to} placeholder="0x…" spellCheck={false} onChange={(e) => setTo(e.target.value)} />}
      </Field>
      {vault.feePerTx != null && (
        <span className="text-[13px] text-muted">
          Network fee, paid from the vault: {quote ? `≈ ${formatEth(quote.total)} ETH at today's base fee` : "enter an address for an estimate"} (at most {formatEth(vault.feePerTx)} ETH).
        </span>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="primary" icon={ArrowUpFromLine} loading={busy} className="self-start" onClick={submit}>
        Withdraw
      </Button>
    </>
  );
}
