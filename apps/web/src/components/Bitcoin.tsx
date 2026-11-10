"use client";
// Bitcoin testnet vault (contract D20): the owner sets it up, funds it and
// names heirs' Bitcoin addresses; guardians include its coins in a proposal
// and rebase if the vault moved; heirs see their payout like any other.
import { ArrowUpFromLine, Pencil, Plus, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BTC_EXPLORER } from "@/lib/config";
import { MAX_BTC_INPUTS, btcUtxos, getBtcDestinations, getBtcRelease, getBtcVault, getConfig, view as viewCall } from "@/lib/contract";
import { btcSplit, formatBtc, isBtc, looksLikeBtcAddress, shortName } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { BtcDestination, BtcRelease, BtcUtxo, BtcVault, PlanView, ReleaseRules } from "@/lib/types";
import { useConfirm } from "./feedback";
import { Address, Dialog, Field, Term } from "./interactive";
import { useTx } from "./tx";
import { AssetHead, Button, Card, Notice, SectionTitle, Skeleton, TestnetTag, inputClass } from "./ui";

export interface BtcState {
  vault: BtcVault | null | undefined;
  dests: BtcDestination[];
  /** Confirmed vault coins, largest first (null while unread or on error). */
  utxos: BtcUtxo[] | null;
  release: BtcRelease | null;
  maxFeeRate: number;
  reload: () => Promise<void>;
}

export function useBtc(owner: string): BtcState {
  const [vault, setVault] = useState<BtcVault | null | undefined>(undefined);
  const [dests, setDests] = useState<BtcDestination[]>([]);
  const [utxos, setUtxos] = useState<BtcUtxo[] | null>(null);
  const [release, setRelease] = useState<BtcRelease | null>(null);
  const [maxFeeRate, setMax] = useState(5);
  const reload = useCallback(async () => {
    const [v, d, r, cfg] = await Promise.all([
      getBtcVault(owner).catch(() => null),
      getBtcDestinations(owner).catch(() => []),
      getBtcRelease(owner).catch(() => null),
      getConfig().catch(() => null),
    ]);
    setVault(v);
    setDests(d);
    setRelease(r);
    if (cfg?.btc) setMax(cfg.btc.max_fee_rate);
    setUtxos(v ? await btcUtxos(v.address).catch(() => null) : null);
  }, [owner]);
  useEffect(() => {
    void reload();
    const t = setInterval(() => !document.hidden && void reload(), 20_000);
    return () => clearInterval(t);
  }, [reload]);
  return { vault, dests, utxos, release, maxFeeRate, reload };
}

const total = (u: BtcUtxo[]) => u.reduce((a, x) => a + BigInt(x.value), 0n);

/** The coins a proposal reports: the largest few (each payout input needs its own signature). */
export const proposalCoins = (u: BtcUtxo[] | null) => (u ?? []).slice(0, MAX_BTC_INPUTS);

/** Owner: set up the vault, fund it, name Bitcoin destinations, withdraw. */
export function BtcOwnerCard({ view, btc, locked }: { view: PlanView; btc: BtcState; locked: boolean }) {
  const { busy, act } = useTx(btc.reload);
  const [dlg, setDlg] = useState<"dests" | "withdraw" | null>(null);
  const balance = btc.utxos ? total(btc.utxos) : null;
  const coins = proposalCoins(btc.utxos);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <AssetHead ticker="BTC" name="Bitcoin" sub="testnet4" />
        <TestnetTag />
      </div>
      {btc.vault === undefined && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
      )}
      {btc.vault === null && (
        <>
          <p className="text-sm leading-relaxed text-muted">
            Add a Bitcoin <Term k="vault">vault</Term>: an address only this plan controls. Heirs can then receive testnet BTC too.
          </p>
          <Button
            variant="ink"
            icon={Plus}
            className="self-start"
            loading={!!busy}
            onClick={() => act("Set up Bitcoin vault", "register_btc_vault", { owner: view.plan.owner }, { tgas: 50, done: "Bitcoin vault ready." })}
          >
            Set up Bitcoin vault
          </Button>
        </>
      )}
      {btc.vault && (
        <>
          <div className="flex flex-col gap-1">
            <span className="tabular text-[40px] font-medium leading-none tracking-[-0.04em]">{balance != null ? formatBtc(balance) : <Skeleton className="h-10 w-32" />}</span>
            <span className="text-sm text-muted">
              BTC in the <Term k="vault">vault</Term> · {btc.utxos ? `${btc.utxos.length} confirmed coin${btc.utxos.length === 1 ? "" : "s"}` : "reading…"}
            </span>
          </div>
          <Address value={btc.vault.address} href={`${BTC_EXPLORER}/address/${btc.vault.address}`} className="text-muted" label="Bitcoin vault address" />
          <p className="text-[13px] leading-relaxed text-muted">
            Send testnet4 BTC here to include it. Only confirmed coins count; a release pays from the {MAX_BTC_INPUTS} largest, so send one larger amount rather than many small ones.
          </p>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Users aria-hidden className="size-4 text-muted" />
              Who receives BTC
            </span>
            {btc.dests.length ? (
              <ul className="flex flex-col gap-1">
                {btc.dests.map((d) => (
                  <li key={d.account_id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                    <span className="shrink-0">{shortName(d.account_id)}</span>
                    <Address value={d.address} short href={`${BTC_EXPLORER}/address/${d.address}`} className="text-muted" label={`${shortName(d.account_id)}'s Bitcoin address`} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-muted">No one yet. Heirs without a Bitcoin address get no BTC; their share goes to the others.</span>
            )}
          </div>
          {!locked && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" icon={Pencil} disabled={!!busy} onClick={() => setDlg("dests")}>
                {btc.dests.length ? "Edit addresses" : "Add addresses"}
              </Button>
              {coins.length > 0 && (
                <Button variant="outline" size="sm" icon={ArrowUpFromLine} disabled={!!busy} onClick={() => setDlg("withdraw")}>
                  Withdraw
                </Button>
              )}
            </div>
          )}
          {locked && <span className="text-[13px] text-muted">Locked while a release is open, so heirs&apos; amounts can&apos;t change.</span>}
        </>
      )}
      <Dialog open={dlg === "dests"} onClose={() => setDlg(null)} title="Who receives BTC" description="Testnet SegWit addresses (tb1q… or tb1p…). Leave a field empty for none.">
        {dlg === "dests" && <BtcDestinations view={view} btc={btc} busy={!!busy} onSave={(list) => act("Save Bitcoin addresses", "set_btc_destinations", { destinations: list }, { deposit: 10n ** 22n }).then((ok) => ok && setDlg(null))} />}
      </Dialog>
      <Dialog open={dlg === "withdraw"} onClose={() => setDlg(null)} title="Withdraw BTC" description="Change goes back to the vault. One withdrawal at a time; a release can't be proposed until it's done.">
        {dlg === "withdraw" && (
          <BtcWithdraw
            btc={btc}
            busy={!!busy}
            onSubmit={(args, tgas) => act("Withdraw BTC", "withdraw_btc", args, { tgas, done: "Withdrawal signed. It reaches the network shortly." }).then((ok) => ok && setDlg(null))}
          />
        )}
      </Dialog>
    </Card>
  );
}

function BtcDestinations({ view, btc, busy, onSave }: { view: PlanView; btc: BtcState; busy: boolean; onSave: (list: { account_id: string; address: string }[]) => void }) {
  const [rules, setRules] = useState<ReleaseRules | null>(null);
  useEffect(() => void viewCall<ReleaseRules | null>("get_release_rules", { owner: view.plan.owner }).then(setRules).catch(() => {}), [view.plan.owner]);
  // Heirs first, then anyone the release rules can pass a share to.
  const people = [...new Set([...view.plan.policy.heirs.map((h) => h.account_id), ...(rules?.alternates ?? []).map((a) => a.recipient.account_id), ...(rules?.fallback ? [rules.fallback.account_id] : [])])];
  const current = (a: string) => btc.dests.find((d) => d.account_id === a)?.address ?? "";
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const value = (a: string) => (draft[a] ?? current(a)).trim();
  const bad = (a: string) => !!value(a) && !looksLikeBtcAddress(value(a));

  return (
    <>
      {people.map((a) => (
        <Field key={a} label={shortName(a)} hint={a} error={(tried || value(a).length > 8) && bad(a) ? "That isn't a testnet SegWit address (tb1q… or tb1p…)." : null}>
          {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} placeholder="tb1q…" spellCheck={false} value={draft[a] ?? current(a)} onChange={(e) => setDraft({ ...draft, [a]: e.target.value })} />}
        </Field>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={busy}
          onClick={() => {
            setTried(true);
            if (people.some(bad)) return;
            onSave(people.map((a) => ({ account_id: a, address: value(a) })).filter((d) => d.address));
          }}
        >
          Save addresses
        </Button>
      </div>
      <span className="text-xs text-muted">Saving attaches 0.01 NEAR for storage; the unused part comes back.</span>
    </>
  );
}

function BtcWithdraw({ btc, busy, onSubmit }: { btc: BtcState; busy: boolean; onSubmit: (args: Record<string, unknown>, tgas: number) => void }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const coins = proposalCoins(btc.utxos);
  // One 2-output payout at the fee-rate cap stays behind for the network fee.
  const fee = btcSplit({ heirs: 1, inputs: Math.max(coins.length, 1), total: 1n << 62n, maxFeeRate: btc.maxFeeRate }).reserve;
  const max = total(coins) > fee + 330n ? total(coins) - fee - 330n : 0n;

  async function submit() {
    setError(null);
    const [w = "0", f = ""] = amount.trim().split(".");
    if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f) || f.length > 8) return setError("Enter an amount in BTC.");
    const sats = BigInt(w || "0") * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
    if (sats < 330n) return setError("Enter at least 0.0000033 BTC (smaller outputs aren't relayed).");
    if (sats > max) return setError(`At most ${formatBtc(max)} BTC from the vault's ${coins.length} largest coin${coins.length === 1 ? "" : "s"}; the rest pays the network fee.`);
    if (!looksLikeBtcAddress(to)) return setError("Enter a testnet SegWit address (tb1q… or tb1p…).");
    const ok = await confirm({
      title: `Withdraw ${formatBtc(sats)} BTC?`,
      rows: [
        ["To", <span key="to" className="font-mono text-xs">{to.trim()}</span>],
        ["Network fee", `at most ${formatBtc(fee)} BTC, from the vault`],
      ],
      body: "Bitcoin transactions can't be reversed. Check the address.",
      confirmLabel: "Withdraw",
    });
    if (ok) onSubmit({ utxos: coins, amount: sats.toString(), to: to.trim() }, 50 * coins.length + 60);
  }
  if (!session || coins.length === 0) return <p className="text-sm text-muted">No confirmed coins to withdraw.</p>;
  return (
    <>
      <Field label="Amount (BTC)" hint={`Up to ${formatBtc(max)} BTC.`}>
        {(p) => (
          <div className="flex gap-2">
            <input {...p} className={inputClass} inputMode="decimal" value={amount} placeholder={formatBtc(max)} onChange={(e) => setAmount(e.target.value)} />
            <Button variant="subtle" size="sm" className="min-h-12" onClick={() => setAmount(formatBtc(max))}>
              Max
            </Button>
          </div>
        )}
      </Field>
      <Field label="To (testnet address)">{(p) => <input {...p} className={`${inputClass} font-mono text-sm`} value={to} placeholder="tb1q…" spellCheck={false} onChange={(e) => setTo(e.target.value)} />}</Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="primary" icon={ArrowUpFromLine} loading={busy} onClick={submit} className="self-start">
        Withdraw
      </Button>
    </>
  );
}

/** Guardian: what the Bitcoin vault adds to a proposal. */
export function btcProposal(view: PlanView, btc: BtcState) {
  const heirs = view.plan.policy.heirs.filter((h) => btc.dests.some((d) => d.account_id === h.account_id)).length;
  const coins = heirs > 0 ? proposalCoins(btc.utxos) : [];
  const split = btcSplit({ heirs, inputs: coins.length, total: total(coins), maxFeeRate: btc.maxFeeRate });
  return { heirs, coins, split, ready: heirs === 0 || !btc.vault || btc.utxos !== null };
}

/** Guardian: re-point unsent Bitcoin payouts at the vault's real coins (after a Conflict). */
export function BtcRebase({ view, btc }: { view: PlanView; btc: BtcState }) {
  const { busy, act } = useTx(btc.reload);
  const transfers = view.plan.proposal?.transfers ?? [];
  const mine = transfers.filter((t) => isBtc(t.asset));
  const sent = mine.some((t) => t.state === "Signing" || t.state === "Broadcast" || t.state === "Confirmed");
  if (!mine.length || sent || !mine.some((t) => t.failure === "Conflict")) return null;
  const coins = proposalCoins(btc.utxos);
  return (
    <Card className="flex flex-col gap-3 border-[var(--s-failed-bg)] bg-error-bg/40">
      <SectionTitle icon={RefreshCw} title="Bitcoin vault moved" />
      <p className="text-sm leading-relaxed">
        A coin this release planned to spend is gone, so the Bitcoin payouts can&apos;t go through. Nothing reached the Bitcoin network. Point them at the vault&apos;s current coins; the amounts stay the same.
      </p>
      <Button
        variant="ink"
        icon={RefreshCw}
        className="self-start"
        loading={!!busy}
        disabled={coins.length === 0}
        onClick={() => act("Update Bitcoin coins", "rebase_btc", { owner: view.plan.owner, utxos: coins }, { tgas: 50 })}
      >
        Use the vault&apos;s current coins ({formatBtc(total(coins))} BTC)
      </Button>
    </Card>
  );
}
