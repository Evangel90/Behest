"use client";
// Release rounds (contract D21): proposing a release or a follow-up round,
// checking a proposal's reported balances against the live vaults before
// approving, and the plan's past releases.
import { useEffect, useState } from "react";
import { getConfig, getReleaseHistory, view as viewCall } from "@/lib/contract";
import { assetLabel, formatAmount, formatBtc, formatEth, formatNear, formatToken, shortName, vaultSplit, when, day } from "@/lib/plan";
import type { Asset, ContractConfig, PlanView, Proposal } from "@/lib/types";
import { useBtcQuote, useEthQuote, type EthTx } from "@/lib/fees";
import { useVault } from "@/lib/vault";
import { btcProposal, useBtc } from "./Bitcoin";
import { Row, TransferTable } from "./PlanParts";
import { Bracket, Button, Card, Chip, Notice } from "./ui";

type Act = (label: string, method: string, args: Record<string, unknown>) => unknown;

/** Settled releases, oldest first; reloads when `key` changes. */
export function useHistory(owner: string, key?: unknown): Proposal[] | null {
  const [h, setH] = useState<Proposal[] | null>(null);
  useEffect(() => void getReleaseHistory(owner).then(setH).catch(() => setH([])), [owner, key]);
  return h;
}

export const lastSettledAt = (h: Proposal[] | null) => (h?.length ? h[h.length - 1]!.created_at_ms : null);

/**
 * Propose a release (guardian, owner overdue) or a follow-up round for what
 * is left after a settled one (guardian or heir). Amounts come from the live
 * vaults; the contract splits them by the plan's rules.
 */
export function ProposeCard({ view, act, busy, followUp, asHeir }: { view: PlanView; act: Act; busy: boolean; followUp: boolean; asHeir?: boolean }) {
  const vault = useVault(view.plan.owner);
  const btc = useBtc(view.plan.owner);
  const bp = btcProposal(view, btc);
  const [cfg, setCfg] = useState<ContractConfig | null>(null);
  useEffect(() => void getConfig().then(setCfg).catch(() => {}), []);
  const name = shortName(view.plan.owner);
  const ethHeirs = view.plan.policy.heirs.filter((h) => h.eth_destination).length;
  const heldTokens = (vault?.tokens ?? []).filter((t) => t.balance != null && t.balance > 0n);
  const split =
    cfg && vault?.balance != null
      ? vaultSplit({ ethHeirs, ethBalance: vault.balance, tokenBalances: heldTokens.map((t) => t.balance!), gasLimit: cfg.eth_gas_limit, feeCap: BigInt(cfg.eth_max_fee_cap) })
      : null;
  // Every vault transaction this proposal would create, for the fee quote (D6).
  const ethTxs: EthTx[] = view.plan.policy.heirs.flatMap((h) =>
    h.eth_destination
      ? [...((split?.ethToSplit ?? 0n) > 0n ? [{ to: h.eth_destination as `0x${string}` }] : []), ...heldTokens.map((t) => ({ to: h.eth_destination as `0x${string}`, token: t.token.address as `0x${string}` }))]
      : [],
  );
  const ethQuote = useEthQuote(cfg, vault?.address ?? null, ethTxs);
  const btcQuote = useBtcQuote(cfg, bp.heirs, bp.coins.length);
  const fts = (view.ft_escrow ?? []).filter((b) => b.amount !== "0");
  const btcToSplit = "error" in bp.split ? 0n : bp.split.toSplit;
  const reading = (ethHeirs > 0 && (vault?.balance == null || vault.tokens.some((t) => t.balance == null))) || !bp.ready;
  const nothing =
    !reading && BigInt(view.plan.escrow) === 0n && fts.length === 0 && (ethHeirs === 0 || ((split?.ethToSplit ?? 0n) === 0n && heldTokens.length === 0)) && btcToSplit === 0n;
  const title = followUp ? "Propose a follow-up release" : "Propose a release";
  return (
    <Card className="flex flex-col gap-4">
      <Bracket>{title}</Bracket>
      <p>
        {followUp
          ? `A release of ${name}'s plan completed and ${name} hasn't checked in since. Anything left in the plan (later deposits, or an amount the last proposal missed) can go out in a follow-up round, split by the same rules. ${asHeir ? "The guardians approve it" : "The other guardians approve it"}, and ${name} can still cancel until the waiting period ends.`
          : `${name} hasn't checked in since ${when(view.plan.last_check_in_ms)}. Proposing freezes the plan and asks the other guardians to approve. ${name} can still cancel until the waiting period ends.`}
      </p>
      <div className="grid gap-1">
        <Row k="NEAR to distribute" v={`${formatNear(view.plan.escrow)} NEAR`} />
        {fts.map((b) => (
          <Row key={b.token} k={`${assetLabel({ Nep141: b.token })} to distribute`} v={formatAmount({ asset: { Nep141: b.token }, amount: b.amount })} />
        ))}
        {ethHeirs > 0 && (
          <>
            <Row k="ETH in vault" v={vault?.balance != null ? `${formatEth(vault.balance)} ETH` : "reading…"} />
            {heldTokens.map(({ token, balance }) => (
              <Row key={token.address} k={`${token.symbol} to distribute`} v={`${formatToken(balance!, token)} ${token.symbol}`} />
            ))}
            <Row k="Network-fee reserve" v={split ? `${formatEth(split.reserve)} ETH (worst case, ${split.transfers} transfer${split.transfers === 1 ? "" : "s"})` : "…"} />
            {ethTxs.length > 0 && (
              <Row
                k="Likely network fees"
                v={ethQuote ? `≈ ${formatEth(ethQuote.total)} ETH at today's base fee; the unused reserve stays in the vault` : "estimating…"}
              />
            )}
            <Row k="ETH to distribute" v={split ? `${formatEth(split.ethToSplit)} ETH` : "…"} />
            {split?.error && <Notice tone="error">The vault doesn't hold enough ETH to pay the network fees for these transfers. Add ETH to the vault first.</Notice>}
          </>
        )}
        {bp.heirs > 0 && btc.vault && (
          <>
            <Row k="BTC in vault (used)" v={btc.utxos ? `${formatBtc(bp.coins.reduce((a, c) => a + BigInt(c.value), 0n))} BTC · ${bp.coins.length} coin${bp.coins.length === 1 ? "" : "s"}` : "reading…"} />
            {bp.coins.length > 0 && (
              <>
                <Row k="Bitcoin fee reserve" v={`${formatBtc(bp.split.reserve)} BTC (worst case, ${bp.heirs} payout${bp.heirs === 1 ? "" : "s"})`} />
                {btcQuote && (
                  <Row
                    k="Likely Bitcoin fees"
                    v={`≈ ${formatBtc(btcQuote.likely)} BTC at ${btcQuote.feeRate} sat/vB${btcQuote.bumpLikely ? `; testnet4 wants about ${Math.ceil(btcQuote.networkRate!)} sat/vB now, so expect a fee bump (paid from the reserve)` : ""}`}
                  />
                )}
                <Row k="BTC to distribute" v={`${formatBtc(btcToSplit)} BTC`} />
              </>
            )}
            {"error" in bp.split && <Notice tone="error">The Bitcoin vault&apos;s coins don&apos;t cover the network fees for these payouts. Add BTC to the vault first.</Notice>}
          </>
        )}
      </div>
      {nothing && <Notice>Nothing is left to distribute right now.</Notice>}
      <Button
        className="self-start"
        disabled={busy || reading || nothing || "error" in bp.split || (ethHeirs > 0 && !!split?.error)}
        onClick={() =>
          act(title, "propose_release", {
            owner: view.plan.owner,
            eth_balance: ethHeirs > 0 && vault?.balance ? vault.balance.toString() : null,
            erc20_balances: ethHeirs > 0 && heldTokens.length ? heldTokens.map((t) => ({ token: t.token.address, amount: t.balance!.toString() })) : null,
            btc_utxos: bp.coins.length ? bp.coins : null,
          })
        }
      >
        {busy ? "Proposing…" : title}
      </Button>
    </Card>
  );
}

const sameAsset = (a: Asset, b: Asset) => JSON.stringify(a) === JSON.stringify(b);

interface CheckRow {
  asset: Asset;
  reported: bigint;
  live: bigint | null;
  note?: string;
}

/**
 * Before approving: the balances the proposal was built from next to what the
 * vaults hold now. NEAR and NEP-141 are counted by the contract; ETH, ERC-20
 * and BTC are reported by the proposer, so an under-report (heirs get less)
 * or over-report (transfers fail) shows up here.
 */
export function SnapshotCheck({ view }: { view: PlanView }) {
  const p = view.plan.proposal;
  const vault = useVault(view.plan.owner);
  const btc = useBtc(view.plan.owner);
  const [snap, setSnap] = useState<[Asset, string][] | null>(null);
  useEffect(() => void viewCall<[Asset, string][]>("get_release_snapshot", { owner: view.plan.owner }).then(setSnap).catch(() => setSnap(null)), [view.plan.owner, p?.id]);
  if (!p || !snap || p.transfers.some((t) => t.state !== "Pending")) return null;

  const ethHeirs = view.plan.policy.heirs.some((h) => h.eth_destination);
  const btcHeirs = btc.dests.length > 0;
  const reported = (a: Asset) => {
    const x = snap.find(([s]) => sameAsset(s, a));
    return x ? BigInt(x[1]) : 0n;
  };
  const rows: CheckRow[] = [];
  if (ethHeirs && vault) {
    rows.push({ asset: "Eth", reported: reported("Eth"), live: vault.balance });
    for (const { token, balance } of vault.tokens) {
      const r = reported({ Erc20: token.address });
      if (r > 0n || (balance ?? 0n) > 0n) rows.push({ asset: { Erc20: token.address }, reported: r, live: balance });
    }
  }
  if (btcHeirs && btc.vault) {
    const live = btc.utxos ? btc.utxos.reduce((a, u) => a + BigInt(u.value), 0n) : null;
    const coins = btc.utxos?.length ?? 0;
    rows.push({ asset: "Btc", reported: reported("Btc"), live, note: coins > 2 ? `A payout spends at most 2 coins; the vault has ${coins}. The rest can go out in a follow-up round.` : undefined });
  }
  if (!rows.length) return null;

  const fmt = (a: Asset, v: bigint) => formatAmount({ asset: a, amount: v.toString() });
  const verdict = (r: CheckRow) => (r.live == null ? "reading" : r.live === r.reported ? "match" : r.live > r.reported ? "more" : "less");
  const verdicts = rows.map(verdict);
  return (
    <section className="flex flex-col gap-3 rounded-tile border border-line p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Check the numbers before you vote</span>
        <span className="text-sm text-muted">
          The proposer reported these balances. NEAR{(view.ft_escrow ?? []).length ? " and NEAR tokens" : ""} ({formatNear(p.near_snapshot)} NEAR) the contract counts itself.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead>
            <tr className="text-[13px] text-muted">
              <th className="py-2 pr-3 font-medium">Asset</th>
              <th className="py-2 pr-3 font-medium">Reported</th>
              <th className="py-2 pr-3 font-medium">In the vault now</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="py-2.5 pr-3">{assetLabel(r.asset)}</td>
                <td className="py-2.5 pr-3">{fmt(r.asset, r.reported)}</td>
                <td className="py-2.5 pr-3">
                  {r.live == null ? "reading…" : fmt(r.asset, r.live)}
                  {r.note && <span className="mt-1 block text-xs text-muted">{r.note}</span>}
                </td>
                <td className="py-2.5 text-right">
                  {verdicts[i] === "match" && <Chip style={{ tone: "active", shape: "circle", label: "" }}>Matches</Chip>}
                  {verdicts[i] === "more" && <Chip style={{ tone: "overdue", shape: "square", label: "" }}>Vault holds more</Chip>}
                  {verdicts[i] === "less" && <Chip style={{ tone: "failed", shape: "diamond", label: "" }}>Vault holds less</Chip>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {verdicts.includes("less") && (
        <Notice tone="error">The vault holds less than reported, so some transfers would fail and the first heirs to receive could get more than their share. Reject this proposal and propose again with the live balance.</Notice>
      )}
      {verdicts.includes("more") && !verdicts.includes("less") && (
        <Notice>
          The vault holds more than this proposal distributes. Approving pays out only the reported amounts; the rest stays in the vault for a follow-up round, which heirs can start too. If the difference looks deliberate, reject it. (Money that arrived after the proposal also shows up here.)
        </Notice>
      )}
    </section>
  );
}

/** Completed releases (D21), newest first. */
export function HistoryCard({ view, history }: { view: PlanView; history: Proposal[] | null }) {
  const past = (history ?? []).filter((h) => h.id !== view.plan.proposal?.id).reverse();
  if (!past.length) return null;
  return (
    <Card className="flex flex-col gap-3">
      <Bracket>Past releases</Bracket>
      {past.map((h, i) => (
        <details key={h.id} open={i === 0} className="group min-w-0 rounded-tile border border-line">
          <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90">›</span>
              Release #{h.id}
            </span>
            <span className="text-sm text-muted">
              proposed by {shortName(h.proposer)} · {day(h.created_at_ms)} · {h.transfers.length} transfer{h.transfers.length === 1 ? "" : "s"}
            </span>
          </summary>
          <div className="p-2 pt-0">
            <TransferTable transfers={h.transfers} />
          </div>
        </details>
      ))}
    </Card>
  );
}
