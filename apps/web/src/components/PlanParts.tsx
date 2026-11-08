"use client";
import { BTC_EXPLORER, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { LIFECYCLE, STATUS_STYLE, formatAmount, isBtc, isEvm, percent, shortAddr, shortName } from "@/lib/plan";
import type { PlanView, Transfer } from "@/lib/types";
import { Bracket, ExtLink, TransferPill, cx } from "./ui";

const SHARE_COLORS = ["#00E59B", "#FFB224", "#9B7BFF", "#4DA3FF", "#FF8A3D", "#F5E14B", "#34D5FF", "#FF6FD8"];

export function Lifecycle({ status }: { status: PlanView["status"] }) {
  const at = LIFECYCLE.indexOf(status);
  return (
    <ol className="grid grid-cols-4 overflow-hidden rounded-tile border border-ink sm:grid-cols-7" aria-label="Lifecycle">
      {LIFECYCLE.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className="border-b border-r border-line px-1.5 py-3 text-center font-mono text-[10.5px] font-bold uppercase sm:border-b-0"
          style={{ background: i === at ? STATUS_STYLE[s].color : i < at ? "#EAE9E2" : "#FFFFFF" }}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}

export function ShareBar({ heirs }: { heirs: { account_id: string; share_bps: number }[] }) {
  return (
    <div className="flex h-9 overflow-hidden rounded-full border-[1.5px] border-ink" aria-hidden="true">
      {heirs.map((h, i) => (
        <span
          key={h.account_id}
          className="flex items-center justify-center font-mono text-xs font-bold [&:not(:last-child)]:border-r-[1.5px] [&:not(:last-child)]:border-ink"
          style={{ width: `${h.share_bps / 100}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }}
        >
          {Math.round(h.share_bps / 100)}
        </span>
      ))}
    </div>
  );
}

export function HeirList({ view }: { view: PlanView }) {
  const heirs = view.plan.policy.heirs;
  return (
    <section aria-label="Heirs" className="flex flex-col gap-3 rounded-card border-[1.5px] border-ink bg-card p-5">
      <Bracket>Heirs · fixed destinations</Bracket>
      <ShareBar heirs={heirs} />
      {heirs.map((h) => (
        <div key={h.account_id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line-soft py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className="font-display text-lg font-semibold">{shortName(h.account_id)}</span>
            <span className="truncate font-mono text-xs text-muted" title={h.account_id}>
              {h.account_id}
            </span>
            {h.near_destination && <span className="truncate font-mono text-xs text-muted">NEAR → {h.near_destination}</span>}
            {h.eth_destination && <span className="truncate font-mono text-xs text-muted">ETH → {shortAddr(h.eth_destination)}</span>}
          </span>
          <span className="font-display text-2xl font-bold">{percent(h.share_bps)}</span>
        </div>
      ))}
    </section>
  );
}

export function GuardianList({ view }: { view: PlanView }) {
  const p = view.plan.proposal;
  const { guardians, quorum } = view.plan.policy;
  return (
    <section aria-label="Guardians" className="void flex flex-col gap-2.5 rounded-card bg-void p-5 text-paper">
      <div className="flex justify-between gap-2">
        <Bracket dark>
          Guardians · {quorum} of {guardians.length} needed
        </Bracket>
        {p && <span className="font-mono text-xs text-testnet">{p.approvals.length} approved</span>}
      </div>
      {guardians.map((g) => {
        const approved = p?.approvals.includes(g);
        const rejected = p?.rejections.includes(g);
        return (
          <div key={g} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-[#1F1F1F] py-2.5 font-mono text-[13px]">
            <span className="min-w-0 truncate">
              <span className="font-sans text-[15px] text-paper">{shortName(g)}</span> <span className="text-muted-dark">{g}</span>
            </span>
            <span style={{ color: approved ? "#00E59B" : rejected ? "#FF5A4E" : "#A3A29C" }}>{approved ? "✓ APPROVED" : rejected ? "✕ REJECTED" : p ? "◷ NOT VOTED" : "STANDING BY"}</span>
          </div>
        );
      })}
    </section>
  );
}

export function receiptUrl(t: Transfer): string | null {
  if (isEvm(t.asset) && t.tx_hash) return `${ETH_EXPLORER}/tx/${t.tx_hash}`;
  if (isBtc(t.asset)) return t.tx_hash ? `${BTC_EXPLORER}/tx/${t.tx_hash}` : null;
  if (!isEvm(t.asset) && t.state === "Confirmed") return `${NEAR_EXPLORER}/address/${t.destination}`;
  return null;
}

export function TransferTable({ transfers, technical }: { transfers: Transfer[]; technical?: boolean }) {
  if (!transfers.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-[1.5px] border-ink font-mono text-[11px] uppercase">
            <th className="p-2">Heir</th>
            <th className="p-2">Amount</th>
            <th className="p-2">To</th>
            <th className="p-2">State</th>
            {technical && <th className="p-2">Nonce · gas</th>}
            <th className="p-2">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => {
            const url = receiptUrl(t);
            return (
              <tr key={i} className="border-b border-line align-top">
                <td className="p-2">{shortName(t.heir)}</td>
                <td className="p-2 font-mono">{formatAmount(t)}</td>
                <td className="p-2 font-mono text-xs" title={t.destination}>
                  {shortAddr(t.destination)}
                </td>
                <td className="p-2">
                  <TransferPill state={t.state} />
                  {t.failure && <span className="mt-1 block font-mono text-xs text-[#B3261E]">{t.failure}</span>}
                </td>
                {technical && <td className="p-2 font-mono text-xs">{t.eth_tx ? `${t.eth_tx.nonce} · ${t.eth_tx.gas_limit.toLocaleString()}` : "—"}</td>}
                <td className="p-2">{url ? <ExtLink href={url} className="font-mono text-xs">{t.tx_hash ? shortAddr(t.tx_hash) : "account"}</ExtLink> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-3 border-t border-line-soft py-2 text-sm">
      <span className="text-muted">{k}</span>
      <span className={cx("min-w-0 break-words", mono && "font-mono text-xs")}>{v}</span>
    </div>
  );
}
