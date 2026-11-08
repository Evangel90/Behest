"use client";
// Bitcoin testnet vault (contract D20): the owner sets it up, funds it and
// names heirs' Bitcoin addresses; guardians include its coins in a proposal
// and rebase if the vault moved; heirs see their payout like any other.
import { useCallback, useEffect, useState } from "react";
import { BTC_EXPLORER } from "@/lib/config";
import { MAX_BTC_INPUTS, btcUtxos, getBtcDestinations, getBtcRelease, getBtcVault, getConfig, view as viewCall } from "@/lib/contract";
import { useAction } from "@/lib/hooks";
import { btcSplit, formatBtc, isBtc, looksLikeBtcAddress, shortName } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { BtcDestination, BtcRelease, BtcUtxo, BtcVault, PlanView, ReleaseRules } from "@/lib/types";
import { Bracket, Button, Card, ExtLink, Field, Notice, TestnetTag, inputClass } from "./ui";

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
    const t = setInterval(reload, 20_000);
    return () => clearInterval(t);
  }, [reload]);
  return { vault, dests, utxos, release, maxFeeRate, reload };
}

const total = (u: BtcUtxo[]) => u.reduce((a, x) => a + BigInt(x.value), 0n);

/** The coins a proposal reports: the largest few (each payout input needs its own signature). */
export const proposalCoins = (u: BtcUtxo[] | null) => (u ?? []).slice(0, MAX_BTC_INPUTS);

/** Owner: set up the vault, fund it, name Bitcoin destinations, withdraw. */
export function BtcOwnerCard({ view, btc, locked }: { view: PlanView; btc: BtcState; locked: boolean }) {
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const call = (label: string, method: string, args: Record<string, unknown>, opts: { deposit?: bigint; tgas?: number } = {}) =>
    run(label, async () => {
      const r = await session!.call(method, args, opts);
      await btc.reload();
      return r;
    });
  const balance = btc.utxos ? total(btc.utxos) : null;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-s-proposed px-2.5 py-1 font-mono text-xs font-bold">BTC · testnet4</span>
        <TestnetTag />
      </div>
      {btc.vault === undefined && <span className="text-muted">Loading…</span>}
      {btc.vault === null && (
        <>
          <p className="text-sm">Add a Bitcoin vault: an address only this plan controls, through Chain Signatures. Heirs can then receive testnet BTC too.</p>
          <Button className="self-start" disabled={!!busy} onClick={() => call("Set up Bitcoin vault", "register_btc_vault", { owner: view.plan.owner }, { tgas: 50 })}>
            {busy ? "Setting up…" : "Set up Bitcoin vault"}
          </Button>
        </>
      )}
      {btc.vault && (
        <>
          <span className="font-display text-[40px] font-bold leading-none tracking-[-0.04em]">{balance != null ? formatBtc(balance) : "…"}</span>
          <span className="break-all font-mono text-xs text-muted">
            vault <ExtLink href={`${BTC_EXPLORER}/address/${btc.vault.address}`}>{btc.vault.address}</ExtLink>
          </span>
          <span className="text-sm text-muted">
            Send testnet4 BTC here to include it. Only confirmed coins count; a release pays from the {MAX_BTC_INPUTS} largest, so send one larger amount rather than many small ones.
          </span>
          <BtcDestinations view={view} btc={btc} locked={locked} busy={!!busy} call={call} />
          {!locked && <BtcWithdraw btc={btc} busy={!!busy} call={call} />}
        </>
      )}
      {result && <Notice tone={result.ok ? "ok" : "error"}>{result.text}</Notice>}
    </Card>
  );
}

type Call = (label: string, method: string, args: Record<string, unknown>, opts?: { deposit?: bigint; tgas?: number }) => unknown;

function BtcDestinations({ view, btc, locked, busy, call }: { view: PlanView; btc: BtcState; locked: boolean; busy: boolean; call: Call }) {
  const [rules, setRules] = useState<ReleaseRules | null>(null);
  useEffect(() => void viewCall<ReleaseRules | null>("get_release_rules", { owner: view.plan.owner }).then(setRules).catch(() => {}), [view.plan.owner]);
  // Heirs first, then anyone the release rules can pass a share to.
  const people = [...new Set([...view.plan.policy.heirs.map((h) => h.account_id), ...(rules?.alternates ?? []).map((a) => a.recipient.account_id), ...(rules?.fallback ? [rules.fallback.account_id] : [])])];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = (a: string) => btc.dests.find((d) => d.account_id === a)?.address ?? "";

  function save() {
    setError(null);
    const list = people.map((a) => ({ account_id: a, address: (draft[a] ?? current(a)).trim() })).filter((d) => d.address);
    const bad = list.find((d) => !looksLikeBtcAddress(d.address));
    if (bad) return setError(`${shortName(bad.account_id)}'s address isn't a testnet SegWit address (tb1q… or tb1p…).`);
    void Promise.resolve(call("Save Bitcoin addresses", "set_btc_destinations", { destinations: list }, { deposit: 10n ** 22n })).then(() => setEditing(false));
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Who receives BTC</span>
        {!locked && !editing && (
          <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {!editing &&
        (btc.dests.length ? (
          btc.dests.map((d) => (
            <span key={d.account_id} className="text-sm">
              {shortName(d.account_id)} → <span className="break-all font-mono text-xs">{d.address}</span>
            </span>
          ))
        ) : (
          <span className="text-sm text-muted">No one yet. Heirs without a Bitcoin address get no BTC; their share goes to the others.</span>
        ))}
      {editing && (
        <>
          {people.map((a) => (
            <Field key={a} label={`${shortName(a)} (${a})`}>
              <input className={`${inputClass} font-mono text-xs`} placeholder="tb1q… (leave empty for none)" value={draft[a] ?? current(a)} onChange={(e) => setDraft({ ...draft, [a]: e.target.value })} />
            </Field>
          ))}
          <div className="flex gap-2">
            <Button disabled={busy} onClick={save}>
              Save
            </Button>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <span className="text-xs text-muted">Saving attaches 0.01 NEAR for storage; the unused part comes back.</span>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function BtcWithdraw({ btc, busy, call }: { btc: BtcState; busy: boolean; call: Call }) {
  const { session } = useSession();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const coins = proposalCoins(btc.utxos);
  // One 2-output payout at the fee-rate cap stays behind for the network fee.
  const fee = btcSplit({ heirs: 1, inputs: Math.max(coins.length, 1), total: 1n << 62n, maxFeeRate: btc.maxFeeRate }).reserve;
  const max = total(coins) > fee + 330n ? total(coins) - fee - 330n : 0n;

  function submit() {
    setError(null);
    const [w = "0", f = ""] = amount.trim().split(".");
    if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f) || f.length > 8) return setError("Enter an amount in BTC.");
    const sats = BigInt(w || "0") * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
    if (sats < 330n) return setError("Enter at least 0.0000033 BTC (smaller outputs aren't relayed).");
    if (sats > max) return setError(`At most ${formatBtc(max)} BTC from the vault's ${coins.length} largest coin${coins.length === 1 ? "" : "s"}; the rest pays the network fee.`);
    if (!looksLikeBtcAddress(to)) return setError("Enter a testnet SegWit address (tb1q… or tb1p…).");
    void call("Withdraw BTC", "withdraw_btc", { utxos: coins, amount: sats.toString(), to: to.trim() }, { tgas: 50 * coins.length + 60 });
  }
  if (!session || coins.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="font-semibold">Withdraw BTC</span>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Amount (BTC)">
          <input className={`${inputClass} w-36`} inputMode="decimal" value={amount} placeholder={formatBtc(max)} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="To (testnet address)">
          <input className={`${inputClass} w-[22rem] max-w-full font-mono text-xs`} value={to} placeholder="tb1q…" onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="outline" disabled={busy} onClick={submit}>
          Withdraw
        </Button>
      </div>
      <span className="text-xs text-muted">Change goes back to the vault. One withdrawal at a time; a release can't be proposed until it's done.</span>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
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
  const { session } = useSession();
  const { busy, result, run } = useAction();
  const transfers = view.plan.proposal?.transfers ?? [];
  const mine = transfers.filter((t) => isBtc(t.asset));
  const sent = mine.some((t) => t.state === "Signing" || t.state === "Broadcast" || t.state === "Confirmed");
  if (!mine.length || sent || !mine.some((t) => t.failure === "Conflict")) return null;
  const coins = proposalCoins(btc.utxos);
  return (
    <Card className="flex flex-col gap-2">
      <Bracket>Bitcoin vault moved</Bracket>
      <p className="text-sm">
        A coin this release planned to spend is gone, so the Bitcoin payouts can't go through. Nothing reached the Bitcoin network. Point them at the vault's current coins; the amounts stay the same.
      </p>
      <Button
        className="self-start"
        disabled={!!busy || coins.length === 0}
        onClick={() =>
          run("Update Bitcoin coins", async () => {
            const r = await session!.call("rebase_btc", { owner: view.plan.owner, utxos: coins }, { tgas: 50 });
            await btc.reload();
            return r;
          })
        }
      >
        Use the vault's current coins ({formatBtc(total(coins))} BTC)
      </Button>
      {result && <Notice tone={result.ok ? "ok" : "error"}>{result.text}</Notice>}
    </Card>
  );
}
