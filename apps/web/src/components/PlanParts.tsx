"use client";
import { BTC_EXPLORER, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { LIFECYCLE, STATUS_STYLE, formatAmount, isBtc, isEvm, percent, shortAddr, shortName } from "@/lib/plan";
import type { PlanView, Transfer } from "@/lib/types";
import { Chip, ExtLink, TransferPill, cx } from "./ui";

/** Heir colours from the design's avatar set; the share bar uses the same order. */
const SHARE_COLORS = ["#2F6BFF", "#FB7A1E", "#6366F1", "#06B6D4", "#C026D3", "#16A34A", "#E11D48", "#A16207"];
const AVATAR_BG = ["#A9CCFF", "#FDBA8C", "#C7C8FA", "#A5F3FC", "#F5D0FE", "#BBF7D0", "#FECDD3", "#FDE68A"];

/** Bordered list card: a title strip over a white inset list (design "Balances"/"Heirs"). */
export function ListCard({ title, aside, children, className }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0 rounded-row border border-line bg-subtle px-1 pb-1", className)}>
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm font-semibold">
        <span>{title}</span>
        {aside && <span className="font-medium text-muted">{aside}</span>}
      </div>
      <div className="overflow-hidden rounded-tile border border-line bg-card">{children}</div>
    </section>
  );
}

export function Avatar({ name, i }: { name: string; i: number }) {
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm text-[#0A0A0A]" style={{ background: AVATAR_BG[i % AVATAR_BG.length] }}>
      {(shortName(name)[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function Lifecycle({ status }: { status: PlanView["status"] }) {
  const at = LIFECYCLE.indexOf(status);
  return (
    <ol className="grid grid-cols-4 gap-1 sm:grid-cols-7" aria-label="Lifecycle">
      {LIFECYCLE.map((s, i) => (
        <li key={s} aria-current={i === at ? "step" : undefined} className="flex flex-col gap-1.5">
          <span
            className="h-1.5 rounded-full"
            style={{ background: i === at ? `var(--s-${STATUS_STYLE[s].tone}-fg)` : i < at ? "var(--line-strong)" : "var(--line)" }}
            aria-hidden="true"
          />
          <span className={cx("text-xs", i === at ? "font-semibold text-ink" : "text-muted")}>{STATUS_STYLE[s].label}</span>
        </li>
      ))}
    </ol>
  );
}

export function ShareBar({ heirs }: { heirs: { account_id: string; share_bps: number }[] }) {
  return (
    <div className="flex h-2.5 gap-[3px]" aria-hidden="true">
      {heirs
        .filter((h) => h.share_bps > 0)
        .map((h, i) => (
          <span key={h.account_id} className="rounded-tag" style={{ width: `${h.share_bps / 100}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
        ))}
    </div>
  );
}

export function HeirList({ view }: { view: PlanView }) {
  const heirs = view.plan.policy.heirs;
  return (
    <ListCard title="Heirs" aside={`${percent(heirs.reduce((a, h) => a + h.share_bps, 0))} allocated`}>
      <div className="px-5 pt-4">
        <ShareBar heirs={heirs} />
      </div>
      <ul>
        {heirs.map((h, i) => (
          <li key={h.account_id} className={cx("flex items-center justify-between gap-3 px-5 py-4", i > 0 && "border-t border-line")}>
            <span className="flex min-w-0 items-center gap-3">
              <Avatar name={h.account_id} i={i} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[15px]">{shortName(h.account_id)}</span>
                <span className="truncate font-mono text-xs text-muted" title={h.account_id}>
                  {[h.near_destination && `NEAR · ${h.near_destination}`, h.eth_destination && `ETH · ${shortAddr(h.eth_destination)}`].filter(Boolean).join("  ·  ") || h.account_id}
                </span>
              </span>
            </span>
            <span className="text-[17px]">{percent(h.share_bps)}</span>
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

export function GuardianList({ view }: { view: PlanView }) {
  const p = view.plan.proposal;
  const { guardians, quorum } = view.plan.policy;
  return (
    <ListCard title={`Guardians · any ${quorum} of ${guardians.length}`} aside={p ? `${p.approvals.length} approved` : undefined}>
      <ul>
        {guardians.map((g, i) => {
          const approved = p?.approvals.includes(g);
          const rejected = p?.rejections.includes(g);
          return (
            <li key={g} className={cx("flex items-center justify-between gap-3 px-5 py-4", i > 0 && "border-t border-line")}>
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={g} i={i + 3} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[15px]">{shortName(g)}</span>
                  <span className="truncate font-mono text-xs text-muted">{g}</span>
                </span>
              </span>
              {approved ? (
                <Chip style={{ tone: "active", shape: "circle", label: "" }}>Approved</Chip>
              ) : rejected ? (
                <Chip style={{ tone: "failed", shape: "diamond", label: "" }}>Rejected</Chip>
              ) : p ? (
                <Chip style={{ tone: "cancelled", shape: "square", label: "" }}>Not voted</Chip>
              ) : (
                <span className="text-sm text-muted">Standing by</span>
              )}
            </li>
          );
        })}
      </ul>
    </ListCard>
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
    <div className="overflow-x-auto rounded-tile border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="bg-subtle text-[13px] text-muted">
            <th className="px-4 py-3 font-medium">Heir</th>
            <th className="px-4 py-3 font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">To</th>
            <th className="px-4 py-3 font-medium">State</th>
            {technical && <th className="px-4 py-3 font-medium">Nonce · gas</th>}
            <th className="px-4 py-3 font-medium">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => {
            const url = receiptUrl(t);
            return (
              <tr key={i} className="border-t border-line align-top">
                <td className="px-4 py-3">{shortName(t.heir)}</td>
                <td className="px-4 py-3">{formatAmount(t)}</td>
                <td className="px-4 py-3 font-mono text-xs" title={t.destination}>
                  {shortAddr(t.destination)}
                </td>
                <td className="px-4 py-3">
                  <TransferPill state={t.state} />
                  {t.failure && <span className="mt-1 block font-mono text-xs text-error">{t.failure}</span>}
                </td>
                {technical && <td className="px-4 py-3 font-mono text-xs">{t.eth_tx ? `${t.eth_tx.nonce} · ${t.eth_tx.gas_limit.toLocaleString()}` : "—"}</td>}
                <td className="px-4 py-3">{url ? <ExtLink href={url} className="font-mono text-xs">{t.tx_hash ? shortAddr(t.tx_hash) : "account"}</ExtLink> : <span className="text-muted">—</span>}</td>
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
    <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-3 border-t border-line py-2.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={cx("min-w-0 break-words", mono && "break-all font-mono text-xs")}>{v}</span>
    </div>
  );
}
